/**
 * Edit Filter Discord Webhook notifier
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
const embed = {
    add: {
        color: 0x00AF89,
        icon_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/MobileFrontend_bytes-added.svg/512px-MobileFrontend_bytes-added.svg.png"
    },
    remove: {
        color: 0xDD3333,
        icon_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/MobileFrontend_bytes-removed.svg/512px-MobileFrontend_bytes-removed.svg.png"
    },
    zero: {
        color: 0x72777D,
        icon_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/MobileFrontend_bytes-neutral.svg/512px-MobileFrontend_bytes-neutral.svg.png"
    },
    log: {
        color: 0x3066CD,
        icon_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/OOjs_UI_icon_information-progressive.svg/240px-OOjs_UI_icon_information-progressive.svg.png"
    }
};
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
        reopenOnClose: true
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
            !data.log_params || !data.log_params.log || !data.log_params.filter ||
            // Edit was not in filter list.
            (FILTERS.length > 0 && !FILTERS.includes(data.log_params.filter)) ||
            // Already processed this event
            (savedLastEventId && JSON.parse(savedLastEventId)[0].offset == data.meta.offset)) {
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
        // Wait 1 second, just in case the revision isn't immediately available
        await new Promise(resolve => setTimeout(resolve, 1000));
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
        let newPage = false;
        let diffSize = null;
        let diffComment = null;
        if (revisionId) {
            // Get the diff size
            const diffUrl = new URL(apiUrl);
            diffUrl.searchParams.set("format", "json");
            diffUrl.searchParams.set("formatversion", "2");
            diffUrl.searchParams.set("action", "compare");
            diffUrl.searchParams.set("fromrev", `${revisionId}`);
            diffUrl.searchParams.set("torelative", `prev`);
            diffUrl.searchParams.set("prop", "ids|size|comment");
            [diffSize, diffComment] = await fetch(diffUrl, { headers: { "User-Agent": USER_AGENT } })
                .then(r => r.json())
                .then(json => {
                if (json?.warnings) {
                    warn("API returned warnings for diff of revision", revisionId, ":", json.warnings);
                }
                newPage = !json?.compare?.fromrevid;
                return [
                    json?.compare?.tosize - (json?.compare?.fromsize ?? 0),
                    json?.compare?.tocomment ?? null
                ];
            })
                .catch(() => {
                error("Failed to get diff size for revision", revisionId);
                newPage = false;
                return [null, null];
            });
        }
        const pageUrl = `https://${data.meta.domain}/wiki/${encodeURIComponent(data.title.replace(/ /g, "_"))}`;
        const diffUrl = revisionId ? (`https://${data.meta.domain}/wiki/Special:Diff/${revisionId}`) : null;
        const histUrl = `https://${data.meta.domain}/wiki/Special:PageHistory/${encodeURIComponent(data.title.replace(/ /g, "_"))}`;
        const leadingLinks = [
            diffUrl ? `[${newPage ? "new" : "diff"}](${diffUrl})` : null,
            `[hist](${histUrl})`,
            `[log](${logRedirectUrl})`,
        ].filter(x => x !== null).join(" | ");
        let embedDescription = `(${leadingLinks}) . . ${(diffSize != null && Math.abs(diffSize) >= 500) ? '**' : ''}(${diffSize != null ?
            `${Math.sign(diffSize) == 1 ? "+" : ""}${diffSize.toLocaleString()}` :
            `${data.log_type} . . ${data.log_action}`})${(diffSize != null && Math.abs(diffSize) >= 500) ? '**' : ''}`;
        if (comment) {
            embedDescription += ` . . *(${comment})*`;
        }
        if (diffComment) {
            embedDescription += ` . . *(${diffComment})*`;
        }
        const mode = diffSize == null ?
            "log" : (newPage ? "add" : {
            1: "add",
            [-1]: "remove",
            0: "zero"
        }[Math.sign(diffSize)]);
        postQueue.push({
            embeds: [
                {
                    id: 652627557,
                    description: embedDescription,
                    color: embed[mode].color,
                    author: {
                        icon_url: embed[mode].icon_url,
                        name: `${data.title}`,
                        url: pageUrl
                    },
                    footer: {
                        text: `#${data.log_params.filter} | ${new Date(data.timestamp * 1000).toLocaleString("en-US", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" })}`
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
        if (err.message.includes("Too Many Requests")) {
            warn("Rate limited; waiting 60 seconds before reopening stream...");
            setTimeout(async () => {
                log("Reopening stream after rate limit...");
                await stream.close();
                await stream.open();
            }, 60000);
        }
    });
    stream.on("close", () => {
        log("Stream closed.");
    });
    postInterval = setInterval(post, 100);
    process.on("SIGINT", async () => {
        log("Caught SIGINT; closing stream...");
        await stream.close();
        clearInterval(postInterval);
        log("Stream closed. Exiting...");
        process.exit(0);
    });
    await stream.open({
        lastEventId: savedLastEventId ? JSON.parse(savedLastEventId) : undefined
    });
})();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5tanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvbWFpbi5tdHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXdCRztBQUVILE9BQU8sZUFBZSxNQUFNLG1CQUFtQixDQUFDO0FBRWhELE9BQU8sS0FBSyxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBRWxDLFNBQVMsR0FBRyxDQUFDLEdBQUcsSUFBVztJQUN2QixPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDMUQsQ0FBQztBQUNELFNBQVMsSUFBSSxDQUFDLEdBQUcsSUFBVztJQUN4QixPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDM0QsQ0FBQztBQUNELFNBQVMsS0FBSyxDQUFDLEdBQUcsSUFBVztJQUN6QixPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELE1BQU0sS0FBSyxHQUFHO0lBQ1YsR0FBRyxFQUFFO1FBQ0QsS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsbUlBQW1JO0tBQ2hKO0lBQ0QsTUFBTSxFQUFFO1FBQ0osS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsdUlBQXVJO0tBQ3BKO0lBQ0QsSUFBSSxFQUFFO1FBQ0YsS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsdUlBQXVJO0tBQ3BKO0lBQ0QsR0FBRyxFQUFFO1FBQ0QsS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsdUpBQXVKO0tBQ3BLO0NBQ0osQ0FBQztBQUVGLENBQUMsS0FBSyxJQUFJ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