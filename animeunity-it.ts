
/// <reference path="./online-streaming-provider.d.ts" />

/**
 * AnimeUnity.cx - Seanime Provider
 *
 * Nuova struttura API:
 * - GET /api/search?q=
 * - GET /anime/{id}-{slug}
 * - GET /api/anime/{id}/episodes?start=
 * - GET /anime/{id}-{slug}/{videoId}
 *
 * Player:
 * - VixCloud
 * - Estrazione dinamica di embedUrl
 * - Estrazione masterPlaylist HLS
 */

type AnimeVariant = {
    language: string;
    status?: string;
    episodes_count?: number;
};

type AnimeRecord = {
    id: number | string;
    slug: string;
    title: string;
    title_ja?: string | null;
    title_it?: string | null;
    year?: number;
    total_episodes?: number;
    images?: {
        poster?: string | null;
        banner?: string | null;
        cover?: string | null;
    };
    variants?: AnimeVariant[];
};

type SearchResponse = {
    data: AnimeRecord[];
    count: number;
    hasMore: boolean;
};

type VideoRecord = {
    id: number | string;
    language: string;
    runtime?: number;
    scws_id: number | string;
    is_hidden?: boolean;
};

type EpisodeRecord = {
    id: number | string;
    number: string | number;
    seq_number_start: number;
    seq_number_end: number;
    is_filler?: boolean;
    videos: VideoRecord[];
};

type EpisodesResponse = {
    episodes: EpisodeRecord[];
};

type LoadedEpisodes = {
    episodes: EpisodeRecord[];
    start: number;
    tab_size: number;
    total: number;
    offset: number;
};

type AnimePageProps = {
    props: {
        anime?: AnimeRecord;
        episode?: EpisodeRecord;
        video?: VideoRecord;
        loadedEpisodes?: LoadedEpisodes;
        embedUrl?: string | null;
    };
};

type RequestHeaders = {
    [key: string]: string;
};

type MasterPlaylist = {
    url: string;
    params: {
        token: string;
        expires: string;
        asn?: string;
    };
};

class Provider {
    private readonly base = "https://animeunity.cx";

    private readonly agent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private readonly episodePageSize = 120;

    getSettings(): Settings {
        return {
            episodeServers: ["vixcloud"],
            supportsDub: true
        };
    }

    // --------------------------------------------------
    // SEARCH
    // --------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = (opts.query || "").trim();

        if (!query) return [];

        const response = await fetch(
            `${this.base}/api/search?q=${encodeURIComponent(query)}`,
            {
                headers: {
                    ...this.pageHeaders(this.base),
                    Accept: "application/json, text/plain, */*"
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `AnimeUnity search error: HTTP ${response.status}`
            );
        }

        const result = await response.json() as SearchResponse;

        if (!Array.isArray(result.data)) {
            throw new Error(
                "AnimeUnity returned an invalid search response."
            );
        }

        const requestedLanguage = opts.dub ? "ita" : "jpn";

        return result.data
            .filter(anime => {
                if (!anime.id || !anime.slug) return false;

                const variants = anime.variants || [];

                return variants.some(
                    variant =>
                        variant.language === requestedLanguage
                );
            })
            .map(anime => ({
                id: `${anime.id}-${anime.slug}`,
                title: anime.title || anime.slug,
                url: `${this.base}/anime/${anime.id}-${anime.slug}`,
                subOrDub: opts.dub ? "dub" : "sub"
            }));
    }

    // --------------------------------------------------
    // EPISODES
    // --------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const match = id.match(/^(\d+)-(.+)$/);

        if (!match) {
            throw new Error(
                `Invalid AnimeUnity anime ID: ${id}`
            );
        }

        const animeId = match[1];
        const slug = match[2];

        const pageUrl =
            `${this.base}/anime/${animeId}-${slug}`;

        // Load anime page through Inertia.
        const pageResponse = await fetch(
            pageUrl,
            {
                headers: this.inertiaHeaders(this.base)
            }
        );

        if (!pageResponse.ok) {
            throw new Error(
                `AnimeUnity anime page error: HTTP ${pageResponse.status}`
            );
        }

        const page = await pageResponse.json() as AnimePageProps;

        const loaded = page.props?.loadedEpisodes;

        if (!loaded || !Array.isArray(loaded.episodes)) {
            throw new Error(
                "AnimeUnity episode list was not found."
            );
        }

        let records: EpisodeRecord[] = [
            ...loaded.episodes
        ];

        const total = Number(loaded.total || 0);
        const pageSize = Number(
            loaded.tab_size || this.episodePageSize
        );

        // Load remaining episode pages.
        for (
            let start = Number(loaded.start) + pageSize;
            start <= total;
            start += pageSize
        ) {
            const endpoint =
                `${this.base}/api/anime/${animeId}/episodes?start=${start}`;

            const response = await fetch(
                endpoint,
                {
                    headers: {
                        ...this.pageHeaders(pageUrl),
                        Accept: "application/json, text/plain, */*"
                    }
                }
            );

            if (!response.ok) {
                throw new Error(
                    `AnimeUnity episodes error: HTTP ${response.status}`
                );
            }

            const data = await response.json() as EpisodesResponse;

            if (!Array.isArray(data.episodes)) {
                throw new Error(
                    `Invalid episode response at offset ${start}.`
                );
            }

            if (data.episodes.length === 0) break;

            records.push(...data.episodes);
        }

        return this.convertEpisodes(
            records,
            animeId,
            slug
        );
    }

    // --------------------------------------------------
    // CONVERT EPISODES
    // --------------------------------------------------

    private convertEpisodes(
        records: EpisodeRecord[],
        animeId: string,
        slug: string
    ): EpisodeDetails[] {
        const results: EpisodeDetails[] = [];
        const seen = new Set<string>();

        for (const episode of records) {
            const number = Number(
                episode.seq_number_start ||
                episode.number
            );

            if (!Number.isFinite(number) || number <= 0) {
                continue;
            }

            for (const video of episode.videos || []) {
                if (
                    video.is_hidden ||
                    !video.id ||
                    !video.scws_id
                ) {
                    continue;
                }

                const language =
                    video.language === "ita"
                        ? "ITA"
                        : video.language === "jpn"
                            ? "SUB"
                            : video.language.toUpperCase();

                const uniqueId = String(video.id);

                if (seen.has(uniqueId)) continue;

                seen.add(uniqueId);

                const filler = episode.is_filler
                    ? " [Filler]"
                    : "";

                results.push({
                    id: uniqueId,
                    number,
                    title: `Episodio ${number} [${language}]${filler}`,
                    url:
                        `${this.base}/anime/${animeId}-${slug}/${video.id}`
                });
            }
        }

        return results.sort((a, b) => {
            if (a.number !== b.number) {
                return a.number - b.number;
            }

            // Italian version before Japanese version.
            const aDub = a.title.includes("[ITA]");
            const bDub = b.title.includes("[ITA]");

            if (aDub && !bDub) return -1;
            if (!aDub && bDub) return 1;

            return 0;
        });
    }

    // --------------------------------------------------
    // VIDEO SERVER
    // --------------------------------------------------

    async findEpisodeServer(
        episode: EpisodeDetails,
        server: string
    ): Promise<EpisodeServer> {

        const episodeUrl = episode.url.startsWith("http")
            ? episode.url
            : `${this.base}/${episode.url.replace(/^\/+/, "")}`;

        // Request the selected episode using Inertia.
        const episodeResponse = await fetch(
            episodeUrl,
            {
                headers: this.inertiaHeaders(this.base)
            }
        );

        if (!episodeResponse.ok) {
            throw new Error(
                `AnimeUnity video page error: HTTP ${episodeResponse.status}`
            );
        }

        const pageText = await episodeResponse.text();

        let embedUrl: string | null = null;

        // Inertia JSON response.
        try {
            const page = JSON.parse(pageText) as AnimePageProps;
            embedUrl = page.props?.embedUrl || null;
        } catch {
            // Fallback for HTML responses.
            const match = pageText.match(
                /"embedUrl"\s*:\s*"([^"]+)"/
            );

            if (match) {
                embedUrl = match[1]
                    .replace(/\\\//g, "/")
                    .replace(/\\u0026/g, "&");
            }
        }

        if (!embedUrl) {
            throw new Error(
                "AnimeUnity did not return the VixCloud embed URL."
            );
        }

        // Load VixCloud player page.
        const embedResponse = await fetch(
            embedUrl,
            {
                headers: this.pageHeaders(this.base)
            }
        );

        if (!embedResponse.ok) {
            throw new Error(
                `VixCloud embed error: HTTP ${embedResponse.status}`
            );
        }

        const embedHtml = await embedResponse.text();

        const master = this.parseMasterPlaylist(embedHtml);

        const playlistUrl = this.buildPlaylistUrl(
            master,
            embedHtml,
            embedUrl
        );

        const origin = new URL(embedUrl).origin;

        return {
            server: server === "default"
                ? "vixcloud"
                : server,

            headers: {
                Referer: `${origin}/`,
                Origin: origin,
                "User-Agent": this.agent
            },

            videoSources: [
                {
                    url: playlistUrl,
                    type: "m3u8",
                    quality: "auto",
                    subtitles: []
                }
            ]
        };
    }

    // --------------------------------------------------
    // VIXCLOUD MASTER PLAYLIST
    // --------------------------------------------------

    private parseMasterPlaylist(
        html: string
    ): MasterPlaylist {

        const assignment = "window.masterPlaylist";

        const index = html.indexOf(assignment);

        if (index < 0) {
            throw new Error(
                "VixCloud masterPlaylist was not found."
            );
        }

        const start = html.indexOf(
            "{",
            index + assignment.length
        );

        if (start < 0) {
            throw new Error(
                "Invalid VixCloud masterPlaylist."
            );
        }

        const object = this.extractBalancedObject(
            html,
            start
        );

        if (!object) {
            throw new Error(
                "Unable to read VixCloud playlist metadata."
            );
        }

        const params = this.extractPropertyObject(
            object,
            "params"
        );

        if (!params) {
            throw new Error(
                "VixCloud playlist parameters not found."
            );
        }

        const url = this.extractStringProperty(
            object,
            "url"
        );

        const token = this.extractStringProperty(
            params,
            "token"
        );

        const expires = this.extractStringProperty(
            params,
            "expires"
        );

        const asn = this.extractStringProperty(
            params,
            "asn"
        );

        if (!url || !token || !expires) {
            throw new Error(
                "Incomplete VixCloud playlist information."
            );
        }

        return {
            url,
            params: {
                token,
                expires,
                ...(asn ? { asn } : {})
            }
        };
    }

    // --------------------------------------------------
    // BUILD HLS URL
    // --------------------------------------------------

    private buildPlaylistUrl(
        master: MasterPlaylist,
        html: string,
        embedUrl: string
    ): string {

        const url = new URL(master.url);

        url.searchParams.set(
            "token",
            master.params.token
        );

        url.searchParams.set(
            "expires",
            master.params.expires
        );

        if (master.params.asn) {
            url.searchParams.set(
                "asn",
                master.params.asn
            );
        }

        const canPlayFHD =
            /window\.canPlayFHD\s*=\s*true\b/.test(html) ||
            new URL(embedUrl).searchParams.get("canPlayFHD") === "1";

        if (canPlayFHD) {
            url.searchParams.set("h", "1");
        }

        return url.toString();
    }

    // --------------------------------------------------
    // JAVASCRIPT OBJECT PARSING
    // --------------------------------------------------

    private extractPropertyObject(
        source: string,
        property: string
    ): string | null {

        const regex = new RegExp(
            `(?:['"]?${property}['"]?)\\s*:`
        );

        const match = regex.exec(source);

        if (!match) return null;

        const start = source.indexOf(
            "{",
            match.index + match[0].length
        );

        if (start < 0) return null;

        return this.extractBalancedObject(
            source,
            start
        );
    }

    private extractBalancedObject(
        source: string,
        start: number
    ): string | null {

        let depth = 0;
        let quote = "";
        let escaped = false;

        for (let i = start; i < source.length; i++) {
            const char = source[i];

            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (char === "\\") {
                    escaped = true;
                } else if (char === quote) {
                    quote = "";
                }

                continue;
            }

            if (char === "'" || char === '"') {
                quote = char;
            } else if (char === "{") {
                depth++;
            } else if (char === "}") {
                depth--;

                if (depth === 0) {
                    return source.slice(start, i + 1);
                }
            }
        }

        return null;
    }

    private extractStringProperty(
        source: string,
        property: string
    ): string | null {

        const regex = new RegExp(
            `(?:['"]?${property}['"]?)\\s*:\\s*(['"])([\\s\\S]*?)\\1`
        );

        const match = regex.exec(source);

        if (!match) return null;

        return match[2]
            .replace(/\\u0026/g, "&")
            .replace(/\\\//g, "/")
            .replace(/\\(['"])/g, "$1");
    }

    // --------------------------------------------------
    // REQUEST HEADERS
    // --------------------------------------------------

    private pageHeaders(
        referer: string
    ): RequestHeaders {
        return {
            "User-Agent": this.agent,
            Referer: referer,
            Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        };
    }

    private inertiaHeaders(
        referer: string
    ): RequestHeaders {
        return {
            "User-Agent": this.agent,
            Referer: referer,
            Accept: "text/html, application/xhtml+xml",
            "X-Inertia": "true",
            "X-Requested-With": "XMLHttpRequest"
        };
    }
}
