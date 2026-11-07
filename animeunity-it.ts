/// <reference path="./online-streaming-provider.d.ts" />

/**
 * AnimeUnity online-streaming provider for Seanime.
 * Uses only the public catalogue, episode pages and non-DRM HLS playlists
 * already delivered by the site. No login, paywall, CAPTCHA or DRM handling.
 */
class Provider {
    private readonly base = "https://www.animeunity.co"
    private readonly agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"

    getSettings(): Settings {
        return { episodeServers: ["vixcloud"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const archive = await fetch(`${this.base}/archivio`, { headers: this.pageHeaders(this.base) })
        if (!archive.ok) return []
        const archiveHtml = await archive.text()
        const $ = LoadDoc(archiveHtml)
        const csrf = $("meta[name='csrf-token']").attr("content") || ""
        const headers = this.ajaxHeaders(archive as any, `${this.base}/archivio`, csrf)
        const payload = JSON.stringify({
            title: opts.query || false,
            type: false,
            year: opts.year ? String(opts.year) : false,
            order: false,
            status: false,
            genres: false,
            offset: 0,
            dubbed: opts.dub,
            season: false,
        })
        const response = await fetch(`${this.base}/archivio/get-animes`, {
            method: "POST", headers, body: payload,
        })
        if (!response.ok) return []
        const data = await response.json() as { records?: AnimeRecord[] }
        return (data.records || []).map((anime) => ({
            id: `${anime.id}-${anime.slug}`,
            title: anime.title_eng || anime.title || anime.slug,
            url: `${this.base}/anime/${anime.id}-${anime.slug}`,
            subOrDub: anime.dub ? "dub" : "sub",
        }))
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const pageUrl = `${this.base}/anime/${id}`
        const response = await fetch(pageUrl, { headers: this.pageHeaders(this.base) })
        if (!response.ok) throw new Error(`AnimeUnity returned HTTP ${response.status} while loading episodes.`)
        const html = await response.text()
        const $ = LoadDoc(html)
        const player = $("video-player").first()
        const rawEpisodes = player.attr("episodes")
        if (!rawEpisodes) throw new Error("AnimeUnity episode metadata was not found.")
        let entries = this.parseEpisodes(rawEpisodes)
        const total = parseInt(player.attr("episodes_count") || "0", 10)
        const animeId = id.split("-")[0]
        if (total > entries.length && animeId) {
            const csrf = $("meta[name='csrf-token']").attr("content") || ""
            const headers = this.ajaxHeaders(response as any, pageUrl, csrf)
            for (let start = entries.length + 1; start <= total; start += 120) {
                const end = Math.min(start + 119, total)
                const more = await fetch(`${this.base}/info_api/${animeId}/1?start_range=${start}&end_range=${end}`, { headers })
                if (!more.ok) break
                const extra = await more.json() as { episodes?: EpisodeRecord[] }
                entries = entries.concat(extra.episodes || [])
            }
        }
        const seen: { [key: string]: boolean } = {}
        return entries.map((item) => {
            const number = parseInt(String(item.number).split("-")[0], 10)
            return {
                id: `${id}/${item.id}`,
                number,
                url: `${this.base}/anime/${id}/${item.id}`,
                title: item.file_name || `Episodio ${item.number}`,
            }
        }).filter((item) => Number.isInteger(item.number) && item.number > 0 && !seen[item.id] && (seen[item.id] = true))
            .sort((a, b) => a.number - b.number)
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const episodeUrl = episode.url || `${this.base}/anime/${episode.id}`
        const response = await fetch(episodeUrl, { headers: this.pageHeaders(this.base) })
        if (!response.ok) throw new Error(`AnimeUnity returned HTTP ${response.status} while loading the episode.`)
        const html = await response.text()
        const $ = LoadDoc(html)
        const embedUrl = $("iframe#embed").attr("src") || $("video-player").attr("embed_url") || this.matchEmbedUrl(html)
        if (!embedUrl) throw new Error("No public VixCloud embed was found for this episode.")

        const embed = await fetch(embedUrl, { headers: this.pageHeaders(episodeUrl) })
        if (!embed.ok) throw new Error(`VixCloud returned HTTP ${embed.status}; its temporary stream token may have expired.`)
        const embedHtml = await embed.text()
        const playlist = this.buildMasterPlaylistUrl(embedHtml)
        if (!playlist) throw new Error("VixCloud master playlist metadata was not found.")
        const master = await fetch(playlist, { headers: this.pageHeaders(embedUrl) })
        if (!master.ok) throw new Error(`VixCloud returned HTTP ${master.status} while loading the public playlist.`)
        const sources = this.parseMasterPlaylist(await master.text())
        if (sources.length === 0) throw new Error("No non-DRM HLS rendition was exposed by VixCloud.")
        return {
            server: _server === "default" ? "vixcloud" : _server,
            headers: { Referer: embedUrl, Origin: this.base, "User-Agent": this.agent },
            videoSources: sources,
        }
    }

    private pageHeaders(referer: string): { [key: string]: string } {
        return { Referer: referer, "User-Agent": this.agent, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    }

    private ajaxHeaders(response: any, referer: string, csrf: string): { [key: string]: string } {
        const cookies = this.cookies(response)
        const session = cookies.filter((cookie) => cookie.indexOf("animeunity_session=") === 0).map((cookie) => cookie.split(";")[0]).join("; ")
        const xsrf = cookies.filter((cookie) => cookie.indexOf("XSRF-TOKEN=") === 0)[0]
        const xsrfValue = xsrf ? decodeURIComponent(xsrf.split(";")[0].substring("XSRF-TOKEN=".length)) : ""
        const headers: { [key: string]: string } = {
            ...this.pageHeaders(referer), Accept: "application/json, text/plain, */*", "Content-Type": "application/json;charset=utf-8",
            Origin: this.base, Referer: referer, "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": csrf,
        }
        if (session) headers.Cookie = session
        if (xsrfValue) headers["X-XSRF-TOKEN"] = xsrfValue
        return headers
    }

    private cookies(response: any): string[] {
        const fromCookies = response && response.cookies
        if (Array.isArray(fromCookies)) return fromCookies
        if (fromCookies && typeof fromCookies === "object") return Object.keys(fromCookies).map((key) => `${key}=${fromCookies[key]}`)
        const raw = response && response.rawHeaders && (response.rawHeaders["set-cookie"] || response.rawHeaders["Set-Cookie"])
        return Array.isArray(raw) ? raw : raw ? [raw] : []
    }

    private parseEpisodes(value: string): EpisodeRecord[] {
        try { return JSON.parse(value.replace(/&quot;/g, '"')) as EpisodeRecord[] } catch (_) { return [] }
    }

    private matchEmbedUrl(html: string): string | null {
        const match = html.match(/https:\/\/[^\s"'<>]+\/embed\/[^\s"'<>]+/i)
        return match ? match[0].replace(/&amp;/g, "&") : null
    }

    private buildMasterPlaylistUrl(html: string): string | null {
        const url = (html.match(/url\s*:\s*['"]([^'"]+)/i) || [])[1]
        const token = (html.match(/['"]token['"]\s*:\s*['"]([\w-]+)/i) || [])[1]
        const expires = (html.match(/['"]expires['"]\s*:\s*['"](\d+)/i) || [])[1]
        if (!url || !token || !expires) return null
        return `${url}${url.indexOf("?") >= 0 ? "&" : "?"}h=1&token=${encodeURIComponent(token)}&expires=${encodeURIComponent(expires)}`
    }

    private parseMasterPlaylist(master: string): VideoSource[] {
        const sourceMap: { [key: string]: boolean } = {}
        const result: VideoSource[] = []
        const pattern = /https?:\/\/[^\s"']+\/playlist\/[^\s"']*?(?:\.m3u8)?\?[^\s"']*?type=video[^\s"']*?rendition=(\d+p?)[^\s"']*/gi
        let match: RegExpExecArray | null
        while ((match = pattern.exec(master)) !== null) {
            let url = match[0].replace(/\\u0026/g, "&").replace(/&amp;/g, "&")
            const beforeQuery = url.split("?")[0]
            if (!beforeQuery.endsWith(".m3u8")) url = `${beforeQuery}.m3u8?${url.split("?").slice(1).join("?")}`
            if (sourceMap[url]) continue
            sourceMap[url] = true
            result.push({ url, type: "m3u8", quality: match[1], subtitles: [] })
        }
        return result.sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10))
    }
}

type AnimeRecord = { id: number; slug: string; title_eng?: string; title?: string; dub?: number | boolean }
type EpisodeRecord = { id: number; number: string | number; file_name?: string }
