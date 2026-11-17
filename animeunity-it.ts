
/// <reference path="./online-streaming-provider.d.ts" />

/**
 * AnimeUnity.cx - Seanime Online Streaming Provider
 *
 * Versione revisionata.
 *
 * Gestione:
 * - Ricerca anime tramite API pubblica
 * - Pagine AnimeUnity in HTML con payload Inertia incorporato
 * - Estrazione episodi e varianti linguistiche
 * - Estrazione dinamica dell'embed VixCloud
 * - Costruzione URL HLS con token temporanei
 *
 * - Paginazione completa tramite l'endpoint usato dal lettore AnimeUnity
 */

type AnimeVariant = {
    language?: string;
    status?: string;
    episodes_count?: number;
};

type AnimeRecord = {
    id: number | string;
    slug: string;
    title?: string;
    title_it?: string | null;
    title_ja?: string | null;
    title_eng?: string | null;
    year?: number;
    total_episodes?: number;
    images?: {
        poster?: string | null;
        banner?: string | null;
        cover?: string | null;
    };
    variants?: AnimeVariant[];
};

type VideoRecord = {
    id: number | string;
    language?: string;
    runtime?: number;
    scws_id?: number | string;
    is_hidden?: boolean;
};

type EpisodeRecord = {
    id: number | string;
    number?: string | number;
    seq_number_start?: number;
    seq_number_end?: number;
    is_filler?: boolean;
    videos?: VideoRecord[];
};

type LoadedEpisodes = {
    episodes?: EpisodeRecord[];
    start?: number;
    tab_size?: number;
    total?: number;
    offset?: number;
};

type EpisodesPage = {
    episodes?: EpisodeRecord[];
};

type AnimePageProps = {
    props?: {
        anime?: AnimeRecord;
        episode?: EpisodeRecord;
        video?: VideoRecord;
        loadedEpisodes?: LoadedEpisodes;
        embedUrl?: string | null;
    };
};

type MasterPlaylist = {
    url: string;
    params: {
        token: string;
        expires: string;
        asn?: string;
    };
};

type RequestHeaders = {
    [key: string]: string;
};

class Provider {
    private readonly base = "https://animeunity.cx";

    private readonly agent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    getSettings(): Settings {
        return {
            episodeServers: ["vixcloud"],
            supportsDub: true
        };
    }

    // ==================================================
    // SEARCH
    // ==================================================

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = (opts.query || "").trim();

        if (!query) {
            return [];
        }

        const url =
            `${this.base}/api/search?q=${encodeURIComponent(query)}`;

        const response = await fetch(url, {
            headers: {
                ...this.pageHeaders(this.base),
                Accept: "application/json, text/plain, */*"
            }
        });

        if (!response.ok) {
            throw new Error(
                `AnimeUnity search failed: HTTP ${response.status}`
            );
        }

        const text = await response.text();
        const payload = this.parseJson(text);

        if (!payload) {
            throw new Error(
                "AnimeUnity returned an invalid search response."
            );
        }

        const records = this.extractAnimeRecords(payload);

        if (records.length === 0) {
            return [];
        }

        const results: SearchResult[] = [];

        for (const anime of records) {
            if (!anime.id || !anime.slug) {
                continue;
            }

            const variants = anime.variants || [];

            // Filter by language only when the API actually
            // provides language information.
            if (variants.length > 0) {
                const requestedLanguage = opts.dub ? "ita" : "jpn";

                const hasLanguage = variants.some(
                    variant =>
                        (variant.language || "").toLowerCase() ===
                        requestedLanguage
                );

                if (!hasLanguage) {
                    continue;
                }
            }

            const animeId = String(anime.id);
            const slug = String(anime.slug);

            results.push({
                id: `${animeId}-${slug}`,
                title:
                    anime.title_it ||
                    anime.title ||
                    anime.title_eng ||
                    slug,
                url: `${this.base}/anime/${animeId}-${slug}`,
                subOrDub: opts.dub ? "dub" : "sub"
            });
        }

        return results;
    }

    // ==================================================
    // EXTRACT SEARCH RESULTS
    // ==================================================

    private extractAnimeRecords(payload: any): AnimeRecord[] {
        if (Array.isArray(payload)) {
            return payload as AnimeRecord[];
        }

        if (!payload || typeof payload !== "object") {
            return [];
        }

        const possibleArrays = [
            payload.data,
            payload.results,
            payload.animes,
            payload.items,
            payload.data?.data,
            payload.data?.results,
            payload.data?.animes
        ];

        for (const value of possibleArrays) {
            if (Array.isArray(value)) {
                return value as AnimeRecord[];
            }
        }

        return [];
    }

    // ==================================================
    // FIND EPISODES
    // ==================================================

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

        // AnimeUnity returns HTTP 409 to an Inertia request without the
        // current X-Inertia-Version. The normal HTML response is stable and
        // contains the same page payload in #app[data-page].
        const response = await fetch(pageUrl, {
            headers: this.pageHeaders(this.base)
        });

        if (!response.ok) {
            throw new Error(
                `AnimeUnity anime page failed: HTTP ${response.status}`
            );
        }

        const pageText = await response.text();

        const page = this.parseAnimePage(pageText);

        if (!page) {
            throw new Error(
                "Unable to read AnimeUnity page data. " +
                "The page did not contain valid Inertia information."
            );
        }

        const loaded = page.props?.loadedEpisodes;

        if (!loaded || !Array.isArray(loaded.episodes)) {
            throw new Error(
                "AnimeUnity did not provide the episode list."
            );
        }

        if (loaded.episodes.length === 0) {
            return [];
        }

        const episodes = await this.loadAllEpisodes(
            loaded,
            animeId,
            pageUrl
        );

        return this.convertEpisodes(
            episodes,
            animeId,
            slug
        );
    }

    // ==================================================
    // LOAD ALL EPISODE TABS
    // ==================================================

    private async loadAllEpisodes(
        loaded: LoadedEpisodes,
        animeId: string,
        referer: string
    ): Promise<EpisodeRecord[]> {
        const episodes = [...(loaded.episodes || [])];
        const tabSize = Number(loaded.tab_size) || episodes.length;
        const total = Number(loaded.total) || episodes.length;
        const firstStart = Number(loaded.start) ||
            Number(loaded.offset) || 1;

        // A malformed pagination payload must never turn a playable anime
        // into an unusable one. The first tab remains available in that case.
        if (tabSize <= 0 || total <= episodes.length || total > 10000) {
            return episodes;
        }

        for (
            let start = firstStart + tabSize;
            start < firstStart + total;
            start += tabSize
        ) {
            const url =
                `${this.base}/api/anime/${encodeURIComponent(animeId)}` +
                `/episodes?start=${encodeURIComponent(String(start))}`;

            try {
                const response = await fetch(url, {
                    headers: {
                        ...this.pageHeaders(referer),
                        Accept: "application/json, text/plain, */*"
                    }
                });

                if (!response.ok) {
                    break;
                }

                const page = this.parseJson(await response.text()) as
                    EpisodesPage | null;
                const next = page?.episodes;

                if (!Array.isArray(next) || next.length === 0) {
                    break;
                }

                episodes.push(...next);

                if (next.length < tabSize) {
                    break;
                }
            } catch (_) {
                break;
            }
        }

        return episodes;
    }

    // ==================================================
    // PARSE ANIME PAGE
    // ==================================================

    private parseAnimePage(text: string): AnimePageProps | null {
        if (!text) {
            return null;
        }

        // First possibility: Inertia JSON response.
        const json = this.parseJson(text);

        if (json && json.props) {
            return json as AnimePageProps;
        }

        // Second possibility: regular HTML page.
        // Inertia stores its page payload inside #app[data-page].
        const match = text.match(
            /data-page\s*=\s*["']([\s\S]*?)["']/i
        );

        if (match && match[1]) {
            const decoded = this.decodeHtml(match[1]);
            const parsed = this.parseJson(decoded);

            if (parsed && parsed.props) {
                return parsed as AnimePageProps;
            }
        }

        // Last possibility: escaped page payload.
        const embedded = text.match(
            /"loadedEpisodes"\s*:\s*\{[\s\S]*?\}\s*\}/
        );

        if (embedded) {
            const start = text.lastIndexOf("{", embedded.index || 0);

            if (start >= 0) {
                const object = this.extractBalancedObject(
                    text,
                    start
                );

                if (object) {
                    const parsed = this.parseJson(object);

                    if (parsed?.props) {
                        return parsed as AnimePageProps;
                    }
                }
            }
        }

        return null;
    }

    // ==================================================
    // CONVERT EPISODES
    // ==================================================

    private convertEpisodes(
        records: EpisodeRecord[],
        animeId: string,
        slug: string
    ): EpisodeDetails[] {
        const results: EpisodeDetails[] = [];
        const seen: { [key: string]: boolean } = {};

        for (const episode of records) {
            if (!episode) {
                continue;
            }

            const rawNumber =
                episode.seq_number_start ||
                episode.number;

            const number = this.parseEpisodeNumber(rawNumber);

            if (!number || number <= 0) {
                continue;
            }

            const videos = episode.videos || [];

            for (const video of videos) {
                if (
                    !video ||
                    video.is_hidden ||
                    !video.id
                ) {
                    continue;
                }

                const videoId = String(video.id);

                if (seen[videoId]) {
                    continue;
                }

                seen[videoId] = true;

                const language = this.getLanguageLabel(
                    video.language
                );

                const filler = episode.is_filler
                    ? " [Filler]"
                    : "";

                results.push({
                    id: videoId,
                    number,
                    title:
                        `Episodio ${number} [${language}]${filler}`,
                    url:
                        `${this.base}/anime/${animeId}-${slug}/${videoId}`
                });
            }
        }

        results.sort((a, b) => {
            if (a.number !== b.number) {
                return a.number - b.number;
            }

            const aDub = a.title.includes("[ITA]");
            const bDub = b.title.includes("[ITA]");

            if (aDub && !bDub) {
                return -1;
            }

            if (!aDub && bDub) {
                return 1;
            }

            return 0;
        });

        return results;
    }

    // ==================================================
    // EPISODE NUMBER
    // ==================================================

    private parseEpisodeNumber(value: any): number {
        if (value === undefined || value === null) {
            return 0;
        }

        const text = String(value).trim();

        const match = text.match(/^\d+/);

        if (!match) {
            return 0;
        }

        const number = parseInt(match[0], 10);

        return Number.isFinite(number) ? number : 0;
    }

    // ==================================================
    // LANGUAGE LABEL
    // ==================================================

    private getLanguageLabel(language?: string): string {
        const value = (language || "").toLowerCase();

        if (value === "ita") {
            return "ITA";
        }

        if (value === "jpn") {
            return "SUB";
        }

        if (value === "eng") {
            return "ENG";
        }

        return value ? value.toUpperCase() : "ALTRO";
    }

    // ==================================================
    // FIND EPISODE SERVER
    // ==================================================

    async findEpisodeServer(
        episode: EpisodeDetails,
        server: string
    ): Promise<EpisodeServer> {
        if (!episode.url) {
            throw new Error(
                "AnimeUnity episode URL is missing."
            );
        }

        const episodeUrl = episode.url.startsWith("http")
            ? episode.url
            : `${this.base}/${episode.url.replace(/^\/+/, "")}`;

        // Request the selected episode page.
        const episodeResponse = await fetch(episodeUrl, {
            headers: this.pageHeaders(this.base)
        });

        if (!episodeResponse.ok) {
            throw new Error(
                `AnimeUnity episode request failed: HTTP ${episodeResponse.status}`
            );
        }

        const episodeText = await episodeResponse.text();

        const episodePage = this.parseAnimePage(episodeText);

        let embedUrl: string | null = null;

        if (episodePage?.props?.embedUrl) {
            embedUrl = episodePage.props.embedUrl;
        }

        // HTML / serialized JSON fallback.
        if (!embedUrl) {
            embedUrl = this.extractEmbedUrl(episodeText);
        }

        if (!embedUrl) {
            throw new Error(
                "AnimeUnity did not return a VixCloud embed URL."
            );
        }

        embedUrl = this.decodeUrl(embedUrl);

        // Load VixCloud embed.
        const embedResponse = await fetch(embedUrl, {
            headers: this.pageHeaders(episodeUrl)
        });

        if (!embedResponse.ok) {
            throw new Error(
                `VixCloud embed failed: HTTP ${embedResponse.status}`
            );
        }

        const embedHtml = await embedResponse.text();

        const master = this.parseMasterPlaylist(embedHtml);

        const playlistUrl = this.buildPlaylistUrl(
            master,
            embedHtml,
            embedUrl
        );

        const origin = this.getOrigin(embedUrl);

        return {
            server:
                server === "default"
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

    // ==================================================
    // EXTRACT EMBED URL
    // ==================================================

    private extractEmbedUrl(text: string): string | null {
        if (!text) {
            return null;
        }

        const patterns = [
            /"embedUrl"\s*:\s*"([^"]+)"/i,
            /'embedUrl'\s*:\s*'([^']+)'/i,
            /embed_url\s*=\s*["']([^"']+)["']/i,
            /https?:\\?\/\\?\/[^"'\\\s<>]+\/embed\/[^"'\\\s<>]+/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);

            if (match && match[1]) {
                return this.decodeUrl(match[1]);
            }

            if (match && match[0]) {
                return this.decodeUrl(match[0]);
            }
        }

        return null;
    }

    // ==================================================
    // PARSE VIXCLOUD MASTER PLAYLIST
    // ==================================================

    private parseMasterPlaylist(html: string): MasterPlaylist {
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
                "Invalid VixCloud masterPlaylist object."
            );
        }

        const object = this.extractBalancedObject(
            html,
            start
        );

        if (!object) {
            throw new Error(
                "Unable to extract VixCloud playlist metadata."
            );
        }

        const params = this.extractPropertyObject(
            object,
            "params"
        );

        if (!params) {
            throw new Error(
                "VixCloud playlist parameters were not found."
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
                "VixCloud returned incomplete playlist information."
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

    // ==================================================
    // BUILD HLS PLAYLIST URL
    // ==================================================

    private buildPlaylistUrl(
        master: MasterPlaylist,
        html: string,
        embedUrl: string
    ): string {
        let url = this.decodeUrl(master.url);

        const query: string[] = [];

        const questionIndex = url.indexOf("?");

        let existingQuery = "";

        if (questionIndex >= 0) {
            existingQuery = url.substring(questionIndex + 1);
            url = url.substring(0, questionIndex);
        }

        if (existingQuery) {
            const parts = existingQuery.split("&");

            for (const part of parts) {
                if (
                    part.indexOf("token=") === 0 ||
                    part.indexOf("expires=") === 0 ||
                    part.indexOf("asn=") === 0 ||
                    part.indexOf("h=") === 0
                ) {
                    continue;
                }

                if (part) {
                    query.push(part);
                }
            }
        }

        query.push(
            `token=${encodeURIComponent(master.params.token)}`
        );

        query.push(
            `expires=${encodeURIComponent(master.params.expires)}`
        );

        if (master.params.asn) {
            query.push(
                `asn=${encodeURIComponent(master.params.asn)}`
            );
        }

        const canPlayFHD =
            /window\.canPlayFHD\s*=\s*true\b/.test(html) ||
            /[?&]canPlayFHD=1(?:&|$)/.test(embedUrl);

        if (canPlayFHD) {
            query.push("h=1");
        }

        return `${url}?${query.join("&")}`;
    }

    // ==================================================
    // EXTRACT JAVASCRIPT OBJECT
    // ==================================================

    private extractPropertyObject(
        source: string,
        property: string
    ): string | null {
        const regex = new RegExp(
            `(?:['"]?${property}['"]?)\\s*:`
        );

        const match = regex.exec(source);

        if (!match) {
            return null;
        }

        const start = source.indexOf(
            "{",
            match.index + match[0].length
        );

        if (start < 0) {
            return null;
        }

        return this.extractBalancedObject(
            source,
            start
        );
    }

    // ==================================================
    // BALANCED OBJECT PARSER
    // ==================================================

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
                    return source.substring(start, i + 1);
                }
            }
        }

        return null;
    }

    // ==================================================
    // EXTRACT STRING PROPERTY
    // ==================================================

    private extractStringProperty(
        source: string,
        property: string
    ): string | null {
        const regex = new RegExp(
            `(?:['"]?${property}['"]?)\\s*:\\s*(['"])([\\s\\S]*?)\\1`
        );

        const match = regex.exec(source);

        if (!match) {
            return null;
        }

        return this.decodeUrl(match[2]);
    }

    // ==================================================
    // JSON PARSER
    // ==================================================

    private parseJson(text: string): any {
        if (!text) {
            return null;
        }

        try {
            return JSON.parse(text);
        } catch (_) {
            return null;
        }
    }

    // ==================================================
    // HTML DECODER
    // ==================================================

    private decodeHtml(value: string): string {
        return value
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
    }

    // ==================================================
    // URL DECODER
    // ==================================================

    private decodeUrl(value: string): string {
        return value
            .replace(/\\u0026/g, "&")
            .replace(/\\u003d/g, "=")
            .replace(/\\u002f/g, "/")
            .replace(/\\\//g, "/")
            .replace(/&amp;/g, "&")
            .replace(/\\(['"])/g, "$1")
            .trim();
    }

    // ==================================================
    // GET URL ORIGIN
    // ==================================================

    private getOrigin(url: string): string {
        const match = url.match(
            /^(https?:\/\/[^/]+)/i
        );

        if (!match) {
            throw new Error(
                "Invalid VixCloud embed URL."
            );
        }

        return match[1];
    }

    // ==================================================
    // REQUEST HEADERS
    // ==================================================

    private pageHeaders(referer: string): RequestHeaders {
        return {
            "User-Agent": this.agent,
            Referer: referer,
            Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        };
    }

}
