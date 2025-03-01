import Scraper from '../scraper';
import * as cheerio from 'cheerio';
import * as similarity from 'string-similarity';
import { Episode, RawSource } from '../../types/global';
import { clean, removeSpecialChars } from '../../helper/title';
import { deepMatch } from '../../helper/match';
import RapidCloud from '../../extractor/impl/rapidcloud';
import axios, { proxiedGet } from '../../helper/request';

export default class Zoro extends Scraper {
    override enabled = true;
    override infoOnly = false;
    override subtitle = true;
    override priority = 2;
    override consumetServiceUrl = "https://api.consumet.org/anime/zoro";

    async getSourceConsumet(sourceUrl: string | URL): Promise<RawSource> {
        if (sourceUrl instanceof URL) sourceUrl = sourceUrl.href;

        let rawSource = (await this.get(`${this.consumetServiceUrl}/watch?episodeId=${sourceUrl.replace("/watch/", "").replace("?ep=", "$episode$")}`)).data;

        let primarySource = rawSource?.sources?.find(source => source.quality === "auto");

        if (!primarySource) return undefined;

        let subtitle = rawSource?.subtitles?.find(subtitle => subtitle.lang.toLowerCase() === "English");

        return {
            video: primarySource.url,
            subtitle: subtitle?.url,
            referer: rawSource?.headers?.Referer,
            browser: true
        }
    }

    async getRawSource(sourceUrl, config) {
        sourceUrl = this.url() + sourceUrl;

        const url = `${this.url()}/ajax/v2/episode/servers?episodeId=${new URL(sourceUrl).searchParams.get("ep")}`;

        let response = await this.get(url, {
            Referer: sourceUrl,
        });

        const $ = cheerio.load((await response.data).html);
        const serverId = $('div.ps__-list > div')
            .map((i, el) => ($(el).attr("data-server-id") == "1" ? $(el) : null))
            .get()[0]
            .attr("data-id")!;

        if (!serverId) return undefined;

        response = await this.get(`${this.url()}/ajax/v2/episode/sources?id=${serverId}`, {
            "Referer": sourceUrl
        });

        const videoUrl = new URL((await response.data).link);

        const video = await (new RapidCloud(config.decryptionKey).extract(videoUrl, url));

        return {
            video: video.source.url,
            m3u8: video.source.m3u8,
            subtitle: video.subtitles,
            referer: sourceUrl,
            browser: true
        };
    }

    async fetch(path: string, _, __, excludedNumbers: number[]): Promise<Episode[]> {
        const response = await proxiedGet(`${this.url()}/ajax/v2/episode/list/${path.split("-").pop()}`, {
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                Referer: `${this.url()}/watch${path}`
            }
        });

        const r = (await (await response).data);

        if (!r.status) return undefined;

        const $ = cheerio.load(r.html);

        const episodes = [];

        $("div.detail-infor-content > div > a").each((i, el) => {
            const number = parseInt($(el).attr('data-number')!);
            if (excludedNumbers.includes(number)) return;

            let title = $(el).attr('title');
            const url = $(el).attr('href');
            const filler = $(el).hasClass('ssl-item-filler');

            if (title.startsWith("Episode ")) title = undefined; // What? you seriously put "Episode X" as the episode title???

            episodes.push({
                number: number,
                title: title,
                filler: filler,
                url: url,
            });
        });

        const titles = [];
        const duplicates = [];

        for (let episode of episodes) {
            if (titles.includes(episode.title)) duplicates.push(episodes.indexOf(episode));
            titles.push(episode.title);
        }

        let currentDuplicateNumber;

        for (let duplicate of duplicates) {
            const number = episodes[duplicate].number;
            if (currentDuplicateNumber && number > currentDuplicateNumber) episodes[duplicate].title = undefined;

            currentDuplicateNumber = number;
        }

        return episodes;
    }

    async match(t) {
        let url = `${this.url()}/search?keyword=${decodeURIComponent(t.current.replaceAll(" ", "+"))}`;

        const response = await this.get(url); // No need to proxy here since Zoro.to does not really block people from scraping
        const $ = cheerio.load(await (await response).data);

        const results = [];

        $(".film_list-wrap > div.flw-item").each((i, el) => {
            const title = $(el).find(".film-name > a.dynamic-name").attr("title");
            const url = $(el).find(".film-name > a").attr("href");

            const parsedUrl = new URL(this.url() + url);
            parsedUrl.searchParams.delete("ref");

            results.push({
                title: title,
                path: parsedUrl.pathname
            });
        });

        if (!results.length) return undefined;

        // Zoro.to has a weird search that it's not ranked exactly by relevance. So what we're going to do here is to find all results from first page (relevance based)
        // then after that, find the best match entry based on both english and romaji title
        // However, if both matches have <90% similarity then the match is probably a failure
        // Update: Zoro.to has a cursed naming strategy (e.x. first season uses english name and second season uses romaji name)
        // So we counteract this with an even more cursed strategy:
        // We compare all possible entries with all variations of the title
        // and find the one that best matches for ANY language
        // then check if the similarity of best match for ANY language for THAT language is above 90% (we have to be strict here, don't want to plug some random entries in database)
        // If it's above 90% similar, then the entry is probably a success
        let highestRating = Number.MIN_VALUE, highestEntry = undefined, highestEntryUsedTitle = undefined;

        let pass = false;
        // Attempt 1 - Match the first zoro search element
        const firstResult = results[0]; // It's not exactly sort by relevance but first result is still a viable try, if we can get this right in one hit it can save a lot of time
        for (let alt of [t.english, t.romaji, t.native, ...(t.synonyms || [])]) {
            if (!alt) continue;

            if (deepMatch(alt, firstResult.title, false)) return firstResult;
        }

        if (!pass) {
            // Attempt 2 - match all zoro search elements with a fuzzy match without sorting by relevance
            for (let alt of [t.english, t.romaji, t.native, ...(t.synonyms || [])]) {
                if (!alt) continue;

                for (let result of results) {
                    if (deepMatch(alt, result.title, false)) {
                        return result;
                    }
                }
            }

            // Attempt 3 - Find the best possible match and test against it with deepMatch, which is the last matching attempt we can do
            for (let alt of [t.english, t.romaji, t.native, ...(t.synonyms || [])]) {
                if (!alt) continue;

                let bestResult = similarity.findBestMatch(alt, results.map(r => clean(r.title)));

                let entry = results.find(r => clean(r.title) === bestResult.bestMatch.target);

                if (bestResult.bestMatch.rating > highestRating) {
                    highestRating = bestResult.bestMatch.rating;
                    highestEntry = entry;
                    highestEntryUsedTitle = alt;
                }
            }

            if (highestEntry && deepMatch(highestEntryUsedTitle, highestEntry.title, true, 0.95)) pass = true;
        }

        if (!pass) return undefined;

        return highestEntry;
    }

    name(): string {
        return "Zoro";
    }

    url(): string {
        return "https://zoro.to";
    }
}
