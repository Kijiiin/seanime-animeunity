/**
 * Palinsesto AnimeUnity — plugin SeaAnime indipendente.
 *
 * Non modifica il Release Schedule di SeaAnime. Aggiunge invece una pagina
 * propria nella barra laterale, filtrata sui titoli della lista dell'utente.
 */

type ListMedia = {
    id?: number;
    title?: { userPreferred?: string; romaji?: string; english?: string; native?: string };
    synonyms?: string[];
};

type Release = {
    anime?: { id?: number; slug?: string; title?: string; title_it?: string; title_ja?: string; images?: { poster?: string } };
    isDub?: boolean;
    releaseTime?: string;
    nextEpisodeNumber?: number | string;
    isAired?: boolean;
    isLate?: boolean;
};

type DisplayItem = {
    title: string;
    animeUrl: string;
    image?: string;
    language: string;
    episode: number;
    time: string;
    dateTime: string;
    status: string;
};

const CALENDAR_URL = "https://animeunity.cx/api/calendar";
const ITEMS_KEY = "animeunity-calendar-page-items";
const UPDATED_KEY = "animeunity-calendar-page-updated";
const ERROR_KEY = "animeunity-calendar-page-error";

function init() {
    $ui.register(async (ctx: any) => {
        const page = ctx.newWebview({
            slot: "screen",
            fullWidth: true,
            sidebar: {
                label: "Palinsesto AnimeUnity",
                icon: "📅"
            }
        });

        page.setContent(() => renderPage(
            $store.get(ITEMS_KEY) || [],
            $store.get(UPDATED_KEY) || "Mai",
            $store.get(ERROR_KEY) || ""
        ));

        // Persisted data makes the page useful immediately after a restart.
        const cached = $storage.get(ITEMS_KEY) || [];
        if (cached.length > 0) {
            $store.set(ITEMS_KEY, cached);
            $store.set(UPDATED_KEY, $storage.get(UPDATED_KEY) || "Cache locale");
        }

        await refreshCalendar(ctx, page);
        ctx.setInterval(() => refreshCalendar(ctx, page), 30 * 60 * 1000);
    });
}

async function refreshCalendar(ctx: any, page: any) {
    try {
        const response = await ctx.fetch(CALENDAR_URL);
        if (!response.ok) {
            throw new Error(`AnimeUnity ha risposto con HTTP ${response.status}.`);
        }

        const rawCalendar = response.json();
        if (!rawCalendar || typeof rawCalendar !== "object") {
            throw new Error("Il palinsesto ricevuto da AnimeUnity non è valido.");
        }

        let collection: any;
        try {
            collection = await $anilist.getAnimeCollection(true);
        } catch (_) {
            // Works for local accounts and while AniList is temporarily stale.
            collection = await $anilist.getAnimeCollection(false);
        }

        const titles = listTitles(collection);
        if (titles.size === 0) {
            throw new Error("Non trovo titoli nella lista SeaAnime/AniList attiva.");
        }

        const items = calendarItems(rawCalendar, titles);
        const updated = new Date().toLocaleString("it-IT", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
        });

        $store.set(ITEMS_KEY, items);
        $store.set(UPDATED_KEY, updated);
        $store.set(ERROR_KEY, "");
        $storage.set(ITEMS_KEY, items);
        $storage.set(UPDATED_KEY, updated);
        page.update();
    } catch (error) {
        const message = error instanceof Error ? error.message : "Aggiornamento non riuscito.";
        console.error("AnimeUnity calendar page error:", error);
        $store.set(ERROR_KEY, message);
        page.update();
    }
}

function listTitles(collection: any): Map<string, ListMedia> {
    const output = new Map<string, ListMedia>();
    const lists = collection?.MediaListCollection?.lists || [];

    for (const list of lists) {
        for (const entry of list?.entries || []) {
            const media = entry?.media as ListMedia | undefined;
            if (!media?.id) continue;

            const names = [
                media.title?.userPreferred,
                media.title?.romaji,
                media.title?.english,
                media.title?.native,
                ...(media.synonyms || [])
            ];
            for (const name of names) {
                const normalized = normalize(name || "");
                if (normalized && !output.has(normalized)) output.set(normalized, media);
            }
        }
    }
    return output;
}

function calendarItems(calendar: Record<string, Release[]>, titles: Map<string, ListMedia>): DisplayItem[] {
    const output: DisplayItem[] = [];
    const seen = new Set<string>();

    for (const releases of Object.values(calendar)) {
        if (!Array.isArray(releases)) continue;
        for (const release of releases) {
            const anime = release.anime;
            const title = anime?.title || anime?.title_it || anime?.title_ja;
            const media = title ? titles.get(normalize(title)) : undefined;
            const episode = Number(release.nextEpisodeNumber);
            const date = release.releaseTime ? new Date(release.releaseTime) : null;

            if (!anime?.id || !anime?.slug || !title || !media || !Number.isFinite(episode) ||
                episode <= 0 || !date || Number.isNaN(date.getTime())) continue;

            const language = release.isDub ? "ITA" : "SUB";
            const key = `${anime.id}|${episode}|${language}|${date.toISOString()}`;
            if (seen.has(key)) continue;
            seen.add(key);

            output.push({
                title,
                animeUrl: `https://animeunity.cx/anime/${anime.id}-${anime.slug}`,
                image: anime.images?.poster,
                language,
                episode,
                time: date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
                dateTime: date.toISOString(),
                status: release.isLate ? "In ritardo" : release.isAired ? "Disponibile" : "In arrivo"
            });
        }
    }
    return output.sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
}

function normalize(value: string): string {
    return value.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function esc(value: string): string {
    return value.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function renderPage(items: DisplayItem[], updated: string, error: string): string {
    const cards = items.length
        ? items.map(item => {
            const date = new Date(item.dateTime).toLocaleDateString("it-IT", {
                weekday: "long", day: "numeric", month: "long"
            });
            const image = item.image
                ? `<img src="${esc(item.image)}" alt="" loading="lazy">`
                : `<div class="placeholder">📺</div>`;
            return `<a class="card" href="${esc(item.animeUrl)}" target="_blank" rel="noreferrer">
                ${image}<div class="content"><div class="meta"><span>${esc(date)}</span><span>${esc(item.time)}</span></div>
                <h2>${esc(item.title)}</h2><p>Episodio ${item.episode} · <b>${item.language}</b></p>
                <span class="status ${item.status === "Disponibile" ? "available" : ""}">${esc(item.status)}</span></div></a>`;
        }).join("")
        : `<div class="empty"><h2>Nessuna uscita trovata</h2><p>Il calendario AnimeUnity è stato letto, ma non ci sono titoli corrispondenti nella tua lista per il periodo mostrato.</p></div>`;

    const message = error
        ? `<div class="error"><b>Non riesco ad aggiornare:</b> ${esc(error)}</div>`
        : "";

    return `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
        :root{color-scheme:dark;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#101114;color:#f3f4f6}
        body{margin:0;padding:32px;max-width:1150px;margin:auto}.top{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:28px}.eyebrow{color:#f59e0b;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.08em}h1{margin:4px 0 6px;font-size:30px}.updated{color:#a1a1aa;font-size:14px}.count{background:#27272a;border-radius:18px;padding:8px 13px;font-weight:700;white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}.card{display:flex;min-height:142px;color:inherit;text-decoration:none;background:#191a1f;border:1px solid #2a2b31;border-radius:14px;overflow:hidden;transition:.16s}.card:hover{border-color:#f59e0b;transform:translateY(-2px)}img,.placeholder{width:92px;min-width:92px;object-fit:cover;background:#25262b}.placeholder{display:grid;place-items:center;font-size:32px}.content{padding:14px;min-width:0}.meta{color:#a1a1aa;font-size:12px;display:flex;justify-content:space-between;gap:10px;text-transform:capitalize}h2{font-size:16px;line-height:1.25;margin:9px 0 7px}p{margin:0;color:#c4c4cc;font-size:14px}.status{display:inline-block;margin-top:11px;padding:3px 8px;border-radius:99px;background:#3f3f46;color:#e4e4e7;font-size:12px}.status.available{background:#14532d;color:#bbf7d0}.empty,.error{border-radius:14px;padding:22px;background:#191a1f;border:1px solid #2a2b31}.error{margin-bottom:18px;border-color:#7f1d1d;color:#fecaca}@media(max-width:600px){body{padding:18px}.top{align-items:start;flex-direction:column}}
    </style></head><body><div class="top"><div><div class="eyebrow">Plugin indipendente</div><h1>Palinsesto AnimeUnity</h1><div class="updated">Aggiornato: ${esc(updated)} · solo titoli della tua lista SeaAnime</div></div><div class="count">${items.length} uscite</div></div>${message}<main class="grid">${cards}</main></body></html>`;
}
