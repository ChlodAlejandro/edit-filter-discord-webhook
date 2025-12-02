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
import type { WikimediaEventStreamEventTypes } from "wikimedia-streams";
import * as fs from "fs/promises";
import { diff } from "util";

function log(...args: any[]) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}
function warn(...args: any[]) {
    console.warn(`[${new Date().toUTCString()}]`, ...args);
}
function error(...args: any[]) {
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

    const abuseFilterDescriptionCache = new Map<number, string>();
    const postQueue: any[] = [];

    let postInterval: NodeJS.Timeout | null = null;
    let postLock = false;

    async function post() {
        if (postLock) { 
            return;
        }
        while (postQueue.length > 0) {
            postLock = true;
            const nextPost = postQueue.shift()!;
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
                        } else {
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

    function wikitextCommentToMarkdown(data: WikimediaEventStreamEventTypes["mediawiki.recentchange"], comment?: string): string | null {
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
            (savedLastEventId && JSON.parse(savedLastEventId)[0].offset == data.meta.offset)
        ) {
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
                    const abf = (json as any)?.query?.abusefilters?.[0];
                    if (abf && abf.id === +abusefilterId) {
                        abuseFilterDescription = abf.description;
                        abuseFilterDescriptionCache.set(+abusefilterId, abuseFilterDescription!);
                    } else {
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
                const logEntry = (json as any)?.query?.abuselog?.[0];
                if (logEntry && logEntry.id === +data.log_params!.log) {
                    return logEntry.revid ?? null;
                } else {
                    return null;
                }
            })
            .catch(() => {
                error("Failed to get revision ID for log entry", data.log_params!.log);
                return null;
            });

        let newPage = false;
        let diffSize: number | null = null;
        let diffComment: string | null = null;
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
                    if ((json as any)?.warnings) {
                        warn("API returned warnings for diff of revision", revisionId, ":", (json as any).warnings);
                    }
                    newPage = !(json as any)?.compare?.fromrevid;
                    return [
                        (json as any)?.compare?.tosize - (json as any)?.compare?.fromsize,
                        (json as any)?.compare?.tocomment ?? null
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

        let embedDescription = `(${leadingLinks}) . . ${
            (diffSize != null && Math.abs(diffSize) >= 500) ? '**' : ''
        }(${
            diffSize != null ?
                `${Math.sign(diffSize) == 1 ? "+" : ""}${diffSize.toLocaleString()}` :
                `${data.log_type} . . ${data.log_action}`
        })${
            (diffSize != null && Math.abs(diffSize) >= 500) ? '**' : ''
        }`;
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
            }[Math.sign(diffSize)])

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
                        text: `#${
                            data.log_params!.filter
                        } | ${new Date(data.timestamp * 1000).toLocaleString("en-US", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" })}`
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
        clearInterval(postInterval!);
        log("Stream closed. Exiting...");
        process.exit(0);
    });

    await stream.open({
        lastEventId: savedLastEventId ? JSON.parse(savedLastEventId) : undefined
    });
})();