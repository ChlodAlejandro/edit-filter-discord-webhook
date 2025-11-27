/**
 * AFC Filter Discord webhook notifier
 *
 * `npm i wikimedia-streams`
 *
 * Copyright 2025 Chlod Alejandro <chlod@chlod.net>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the “Software”), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * @author Chlod Alejandro <chlod@chlod.net>
 * @license MIT
 */
import WikimediaStream from "wikimedia-streams";
import * as fs from "fs/promises";
function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}
function warn(...args) {
    console.warn(`[${new Date().toUTCString()}]`, ...args);
}
function error(...args) {
    console.error(`[${new Date().toUTCString()}]`, ...args);
}
(async () => {
    const WEBHOOK = process.env.WEBHOOK;
    if (!WEBHOOK) {
        error("No webhook URL provided! Set the WEBHOOK environment variable.");
        process.exit(1);
    }
    const FILTERS = process.env.FILTERS?.split(",") ?? [];
    const USER_AGENT = process.env.USER_AGENT ?? `AFCDiscordWebhook/1.0 (User:Chlod; chlod@chlod.net) ${WikimediaStream.genericUserAgent}}`;
    const LAST_EVENT_ID_FILE = process.env.LAST_EVENT_ID_FILE ?? `${process.cwd()}/lastEventId.txt`;
    log("Starting...");
    log("Filters to monitor:", FILTERS.length > 0 ? FILTERS.join(", ") : "All");
    const abuseFilterDescriptionCache = new Map();
    const postQueue = [];
    let postInterval = null;
    let postLock = false;
    async function post() {
        if (postLock) {
            return;
        }
        while (postQueue.length > 0) {
            postLock = true;
            const nextPost = postQueue.shift();
            await fetch(WEBHOOK, {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': USER_AGENT,
                },
                body: JSON.stringify(nextPost)
            })
                .then(async (res) => {
                if (!res.ok) {
                    const errorDetails = await res.text();
                    if (res.status === 429) {
                        const retryAfter = JSON.parse(errorDetails)?.retry_after;
                        warn(`Rate limited when sending webhook; waiting ${retryAfter}s before continuing...`);
                        await new Promise(resolve => setTimeout(resolve, (retryAfter ?? 5) * 1000));
                        postQueue.unshift(nextPost);
                    }
                    else {
                        error("Failed to send webhook:", res.status, res.statusText, errorDetails);
                    }
                }
            })
                .catch((err) => {
                error("Failed to send webhook:", err);
            });
        }
        postLock = false;
    }
    function wikitextCommentToMarkdown(data, comment) {
        comment = comment ?? (data.type === "log" ? data.log_action_comment : data.comment);
        if (comment === undefined || comment.trim() === "") {
            return null;
        }
        const base = `https://${data.meta.domain}/wiki/`;
        return comment
            .replace(/\[\[([^\|\]]+)\|([^\]]+)\]\]/g, (_str, target, display) => {
            const url = base + encodeURIComponent(target.replace(/ /g, "_"));
            return `[${display}](${url})`;
        }) // [[Link|Text]] -> Text
            .replace(/\[\[([^\]]+)\]\]/g, (_str, target) => {
            const url = base + encodeURIComponent(target.replace(/ /g, "_"));
            return `[${target}](${url})`;
        }) // [[Link]] -> Link
            .replace(/\/\*\s*(.+?)\s*\*\//g, (_str, target) => {
            const url = base + encodeURIComponent(target.replace(/ /g, "_"));
            return `[\u{2192}${target}:](${url})`;
        }) // /* Comment */ -> section heading
            .trim();
    }
    const savedLastEventId = await fs.readFile(LAST_EVENT_ID_FILE, "utf-8")
        .then(data => data.trim())
        .catch(() => null);
    if (savedLastEventId) {
        log("Using saved last event ID:", savedLastEventId);
    }
    const stream = new WikimediaStream("mediawiki.recentchange", {
        headers: {
            'User-Agent': USER_AGENT
        },
        autoStart: false,
        reopenOnClose: true,
        lastEventId: savedLastEventId ? JSON.parse(savedLastEventId) : undefined
    });
    stream.on("mediawiki.recentchange", async (data) => {
        if (
        // Not English Wikipedia
        data.wiki !== "enwiki" ||
            // Not a log type
            data.type !== "log" ||
            // Not an abuse filter hit
            data.log_type !== "abusefilter" && data.log_action !== "hit" ||
            // Missing log data for some reason
            !data.log_params || !data.log_params.log || !data.log_params.filter) {
            return;
        }
        if (FILTERS.length > 0 && !FILTERS.includes(data.log_params.filter)) {
            // Edit was not in filter list.
            return;
        }
        log("Processing log entry:", data.log_params.log, "by", data.user, "on", data.title);
        const apiUrl = `https://${data.meta.domain}/w/api.php`;
        let comment = wikitextCommentToMarkdown(data);
        if (comment?.startsWith(data.user)) {
            // Upgrade the username at the very start with a link to the user
            const userUrl = `https://${data.meta.domain}/wiki/User:${encodeURIComponent(data.user.replace(/ /g, "_"))}`;
            const userTalkUrl = `https://${data.meta.domain}/wiki/User_talk:${encodeURIComponent(data.user.replace(/ /g, "_"))}`;
            const userContribsUrl = `https://${data.meta.domain}/wiki/Special:Contributions/${encodeURIComponent(data.user.replace(/ /g, "_"))}`;
            comment = comment.replace(data.user, `[${data.user}](${userUrl}) ([talk](${userTalkUrl}) | [contribs](${userContribsUrl}))`);
        }
        const abusefilterId = data.log_params.filter;
        let abuseFilterDescription = abusefilterId ? abuseFilterDescriptionCache.get(+abusefilterId) : null;
        if (abusefilterId && !isNaN(+abusefilterId) && !abuseFilterDescription) {
            // Get the description from the API
            const url = new URL(apiUrl);
            url.searchParams.set("format", "json");
            url.searchParams.set("formatversion", "2");
            url.searchParams.set("action", "query");
            url.searchParams.set("list", "abusefilters");
            url.searchParams.set("abfstartid", abusefilterId);
            url.searchParams.set("abflimit", "1");
            await fetch(url, { headers: { "User-Agent": USER_AGENT } })
                .then(res => res.json())
                .then(json => {
                const abf = json?.query?.abusefilters?.[0];
                if (abf && abf.id === +abusefilterId) {
                    abuseFilterDescription = abf.description;
                    abuseFilterDescriptionCache.set(+abusefilterId, abuseFilterDescription);
                }
                else {
                    abuseFilterDescription = "Unknown (could not find abuse filter; is it private?)";
                    error("Could not find abuse filter description for ID", abusefilterId, "in response:", json);
                }
            })
                .catch(() => {
                abuseFilterDescription = "Unknown (failed to get abuse filter description)";
                error("Failed to get abuse filter description for ID", abusefilterId);
            });
        }
        comment = comment?.replace(/(\s*\(\[details)/, (str) => {
            return `. Filter description: ${abuseFilterDescription} ${str}`;
        }) ?? null;
        const logRedirectUrl = `https://${data.meta.domain}/wiki/Special:AbuseLog/${data.log_params.log}`;
        // Extract revision ID, which isn't in the log params for some reason
        const revIdUrl = new URL(apiUrl);
        revIdUrl.searchParams.set("format", "json");
        revIdUrl.searchParams.set("formatversion", "2");
        revIdUrl.searchParams.set("action", "query");
        revIdUrl.searchParams.set("list", "abuselog");
        revIdUrl.searchParams.set("afllogid", `${data.log_params.log}`);
        revIdUrl.searchParams.set("afllimit", "1");
        const revisionId = await fetch(revIdUrl, { headers: { "User-Agent": USER_AGENT } })
            .then(r => r.json())
            .then(json => {
            const logEntry = json?.query?.abuselog?.[0];
            if (logEntry && logEntry.id === +data.log_params.log) {
                return logEntry.revid ?? null;
            }
            else {
                return null;
            }
        })
            .catch(() => {
            error("Failed to get revision ID for log entry", data.log_params.log);
            return null;
        });
        const pageUrl = `https://${data.meta.domain}/wiki/${encodeURIComponent(data.title.replace(/ /g, "_"))}`;
        const diffUrl = revisionId ? (`https://${data.meta.domain}/wiki/Special:Diff/${revisionId}`) : null;
        const histUrl = `https://${data.meta.domain}/wiki/Special:PageHistory/${encodeURIComponent(data.title.replace(/ /g, "_"))}`;
        const leadingLinks = [
            `[log](${logRedirectUrl})`,
            diffUrl ? `[diff](${diffUrl})` : null,
            `[hist](${histUrl})`
        ].filter(x => x !== null).join(" | ");
        let embedDescription = `(${leadingLinks}) . . (${data.log_type} . . ${data.log_action})`;
        if (comment) {
            embedDescription += ` . . *(${comment})*`;
        }
        postQueue.push({
            embeds: [
                {
                    id: 652627557,
                    description: embedDescription,
                    color: 4156110,
                    author: {
                        icon_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/OOjs_UI_icon_information-progressive.svg/240px-OOjs_UI_icon_information-progressive.svg.png",
                        name: `${data.title}`,
                        url: pageUrl
                    },
                    footer: {
                        text: new Date(data.timestamp * 1000).toLocaleString("en-US", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" })
                    }
                }
            ],
            avatar_url: "https://upload.wikimedia.org/wikipedia/en/thumb/8/80/Wikipedia-logo-v2.svg/263px-Wikipedia-logo-v2.svg.png",
            username: "English Wikipedia"
        });
        // Save the last event ID to a file
        await fs.writeFile(LAST_EVENT_ID_FILE, JSON.stringify([{
                topic: data.meta.topic,
                partition: data.meta.partition,
                offset: data.meta.offset,
            }]), "utf-8")
            .catch((err) => {
            error("Failed to save last event ID:", err);
        });
    });
    stream.on("open", () => {
        log("Stream opened");
    });
    stream.on("error", (err) => {
        error("Stream error:", err);
    });
    stream.on("close", () => {
        log("Stream closed. Reopening...");
        stream.open();
    });
    postInterval = setInterval(post, 100);
    process.on("SIGINT", async () => {
        log("Caught SIGINT; closing stream...");
        await stream.close();
        clearInterval(postInterval);
        log("Stream closed. Exiting...");
        process.exit(0);
    });
    await stream.open();
})();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5tanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvbWFpbi5tdHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXdCRztBQUVILE9BQU8sZUFBZSxNQUFNLG1CQUFtQixDQUFDO0FBRWhELE9BQU8sS0FBSyxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBRWxDLFNBQVMsR0FBRyxDQUFDLEdBQUcsSUFBVztJQUN2QixPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDMUQsQ0FBQztBQUNELFNBQVMsSUFBSSxDQUFDLEdBQUcsSUFBVztJQUN4QixPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDM0QsQ0FBQztBQUNELFNBQVMsS0FBSyxDQUFDLEdBQUcsSUFBVztJQUN6QixPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELENBQUMsS0FBSyxJQUFJLEVBQUU7SUFDUixNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQztJQUVwQyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDWCxLQUFLLENBQUMsZ0VBQWdFLENBQUMsQ0FBQztRQUN4RSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3BCLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQ3RELE1BQU0sVUFBVSxHQUFHLE9BQU8s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