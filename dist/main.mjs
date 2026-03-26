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
    const USER_AGENT = process.env.USER_AGENT ?? `AFCDiscordWebhook/1.1 (User:Chlod; chlod@chlod.net) ${WikimediaStream.genericUserAgent}`;
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
        autoStart: false,
        reopenOnClose: true
    });
    async function saveLastEventId(data) {
        const lastEventId = JSON.stringify([{
                topic: data.meta.topic,
                partition: data.meta.partition,
                offset: data.meta.offset,
            }]);
        console.log("Saving last event ID: ", lastEventId);
        // Save the last event ID to a file
        await fs.writeFile(LAST_EVENT_ID_FILE, lastEventId, "utf-8")
            .catch((err) => {
            error("Failed to save last event ID:", err);
        });
    }
    let sinceLastEventIdSave = 0;
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
            // Save the event ID even if we're not processing it, to avoid reprocessing old events on restart.
            // This helps us recover from long-term outages.
            if (sinceLastEventIdSave > 100) {
                await saveLastEventId(data);
                sinceLastEventIdSave = 0;
            }
            else {
                sinceLastEventIdSave++;
            }
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
                    if ((json.warnings?.compare ?? []).length !== 1 ||
                        !json.warnings.compare[0].warnings.includes("is the earliest revision")) {
                        warn("API returned warnings for diff of revision", revisionId, ":", json.warnings);
                    }
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
            embedDescription += ` . . *(${wikitextCommentToMarkdown(data, diffComment)})*`;
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
        await saveLastEventId(data);
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
        lastEventId: savedLastEventId ? JSON.parse(savedLastEventId) : undefined,
        headers: {
            'User-Agent': USER_AGENT
        },
    });
})();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5tanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvbWFpbi5tdHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXdCRztBQUVILE9BQU8sZUFBZSxNQUFNLG1CQUFtQixDQUFDO0FBRWhELE9BQU8sS0FBSyxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBRWxDLFNBQVMsR0FBRyxDQUFDLEdBQUcsSUFBVztJQUN2QixPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDMUQsQ0FBQztBQUNELFNBQVMsSUFBSSxDQUFDLEdBQUcsSUFBVztJQUN4QixPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDM0QsQ0FBQztBQUNELFNBQVMsS0FBSyxDQUFDLEdBQUcsSUFBVztJQUN6QixPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELE1BQU0sS0FBSyxHQUFHO0lBQ1YsR0FBRyxFQUFFO1FBQ0QsS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsbUlBQW1JO0tBQ2hKO0lBQ0QsTUFBTSxFQUFFO1FBQ0osS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsdUlBQXVJO0tBQ3BKO0lBQ0QsSUFBSSxFQUFFO1FBQ0YsS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsdUlBQXVJO0tBQ3BKO0lBQ0QsR0FBRyxFQUFFO1FBQ0QsS0FBSyxFQUFFLFFBQVE7UUFDZixRQUFRLEVBQUUsdUpBQXVKO0tBQ3BLO0NBQ0osQ0FBQztBQUVGLENBQUMsS0FBSyxJQUFJ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