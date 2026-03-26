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
    let savedLastEventId = await fs.readFile(LAST_EVENT_ID_FILE, "utf-8")
        .then(data => data.trim())
        .catch(() => null);
    if (savedLastEventId) {
        log("Using saved last event ID:", savedLastEventId);
    }
    const stream = new WikimediaStream("mediawiki.recentchange", {
        autoStart: false,
        reopenOnClose: false
    });
    async function saveLastEventId(data, silent = false) {
        const lastEventId = JSON.stringify([{
                topic: data.meta.topic,
                partition: data.meta.partition,
                offset: data.meta.offset,
            }]);
        savedLastEventId = lastEventId;
        if (!silent) {
            console.log("Saving last event ID:", lastEventId);
        }
        // Save the last event ID to a file
        await fs.writeFile(LAST_EVENT_ID_FILE, lastEventId, "utf-8")
            .catch((err) => {
            error("Failed to save last event ID:", err);
        });
    }
    let nextLastEventIdSave = 0;
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
            console.log(data.meta.offset);
            // Save the event ID even if we're not processing it, to avoid reprocessing old events on restart.
            // This helps us recover from long-term outages.
            if (Date.now() > nextLastEventIdSave) {
                // Save every minute.
                await saveLastEventId(data, false);
                nextLastEventIdSave = Date.now() + (60e3);
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