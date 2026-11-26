/**
 * AnimeUnity Schedule for SeaAnime
 *
 * Reads AnimeUnity's public calendar and adds only the releases belonging to
 * titles in the user's SeaAnime/AniList collection. It never logs into
 * AnimeUnity and stores only the generated calendar items locally.
 */

type Title = {
    romaji?: string;
    english?: string;
    native?: string;
    userPreferred?: string;
};

type ListMedia = {
    id?: number;
    title?: Title;
    synonyms?: string[];
    coverImage?: { large?: string; medium?: string };
    format?: string;
    episodes?: number;
};

type CalendarRelease = {
    anime?: {
        id?: number;
        slug?: string;
        title?: string;
        title_it?: string;
        title_ja?: string;
        images?: { poster?: string };
    };
    isDub?: boolean;
    releaseTime?: string;
    nextEpisodeNumber?: string | number;
    isAired?: boolean;
    isLate?: boolean;
};

const SOURCE_PREFIX = "🇮🇹 AnimeUnity — ";
const ITEMS_KEY = "animeunity-schedule-items";
const UPDATED_KEY = "animeunity-schedule-updated-at";
const CALENDAR_URL = "https://animeunity.cx/api/calendar";

function init() {
    // SeaAnime calls this immediately before rendering the schedule. Keeping
    // the hook synchronous lets cached data appear even while a refresh runs.
    $app.onAnimeScheduleItems((event) => {
        try {
            const standardItems = (event.items || []).filter((item: any) =>
                !(item.title || "").startsWith(SOURCE_PREFIX)
            );
            const animeUnityItems = $store.get(ITEMS_KEY) || [];

            const combined = [...standardItems, ...animeUnityItems];
            const seen = new Set<string>();

            event.items = combined.filter((item: any) => {
                // The language is part of the key: AnimeUnity can schedule
                // a dubbed and a subtitled release for the same episode.
                const key = [
                    item.mediaId,
                    item.episodeNumber,
                    item.title || "",
                    item.dateTime || ""
                ].join("|");

                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            event.items.sort((a: any, b: any) => {
                return new Date(a.dateTime || 0).getTime() -
                    new Date(b.dateTime || 0).getTime();
            });
        } catch (error) {
            console.error("AnimeUnity Schedule hook error:", error);
        } finally {
            event.next();
        }
    });

    $ui.register(async (ctx: any) => {
        const cached = $storage.get(ITEMS_KEY) || [];
        if (cached.length > 0) {
            $store.set(ITEMS_KEY, cached);
            $app.invalidateClientQuery(["GetAnimeSchedule"]);
        }

        const tray = ctx.newTray({
            tooltipText: "Palinsesto AnimeUnity",
            withContent: true
        });

        ctx.registerEventHandler("refresh-animeunity-schedule", async () => {
            ctx.toast.info("AnimeUnity: aggiornamento del palinsesto…");
            await refreshSchedule(ctx, true);
        });

        tray.render(() => {
            const updatedAt = $store.get(UPDATED_KEY) || "Mai";
            return tray.stack({
                gap: 2,
                items: [
                    tray.text("Palinsesto AnimeUnity"),
                    tray.text("Solo titoli della tua lista SeaAnime."),
                    tray.text(`Aggiornato: ${updatedAt}`),
                    tray.button("↻ Aggiorna ora", {
                        intent: "primary",
                        onClick: "refresh-animeunity-schedule"
                    })
                ]
            });
        });

        await refreshSchedule(ctx, false);
        // A short cache period avoids needless requests on navigation while
        // keeping the page current enough for same-day release changes.
        ctx.setInterval(() => refreshSchedule(ctx, false), 30 * 60 * 1000);
    });
}

async function refreshSchedule(ctx: any, showResult: boolean) {
    try {
        const [calendarResponse, collection] = await Promise.all([
            ctx.fetch(CALENDAR_URL),
            $anilist.getAnimeCollection(true)
        ]);

        if (!calendarResponse.ok) {
            throw new Error(`AnimeUnity returned HTTP ${calendarResponse.status}`);
        }

        const calendar = calendarResponse.json();
        if (!calendar || typeof calendar !== "object") {
            throw new Error("AnimeUnity returned an invalid calendar.");
        }

        const collectionByTitle = buildCollectionIndex(collection);
        if (collectionByTitle.size === 0) {
            throw new Error("La lista SeaAnime/AniList è vuota o non disponibile.");
        }

        const items = buildScheduleItems(calendar, collectionByTitle);
        $store.set(ITEMS_KEY, items);
        $storage.set(ITEMS_KEY, items);

        const updatedAt = new Date().toLocaleString("it-IT", {
            hour: "2-digit",
            minute: "2-digit",
            day: "2-digit",
            month: "2-digit"
        });
        $store.set(UPDATED_KEY, updatedAt);
        $storage.set(UPDATED_KEY, updatedAt);
        $app.invalidateClientQuery(["GetAnimeSchedule"]);

        if (showResult) {
            ctx.toast.info(`AnimeUnity: trovate ${items.length} uscite nella tua lista.`);
        }
    } catch (error) {
        console.error("AnimeUnity Schedule refresh error:", error);
        if (showResult) {
            ctx.toast.error("AnimeUnity: impossibile aggiornare il palinsesto.");
        }
    }
}

function buildCollectionIndex(collection: any): Map<string, ListMedia> {
    const index = new Map<string, ListMedia>();
    const lists = collection?.MediaListCollection?.lists || [];

    for (const list of lists) {
        for (const entry of list?.entries || []) {
            const media = entry?.media as ListMedia | undefined;
            if (!media?.id) continue;

            for (const title of mediaTitles(media)) {
                const normalized = normalizeTitle(title);
                if (normalized && !index.has(normalized)) {
                    index.set(normalized, media);
                }
            }
        }
    }

    return index;
}

function mediaTitles(media: ListMedia): string[] {
    return [
        media.title?.userPreferred,
        media.title?.romaji,
        media.title?.english,
        media.title?.native,
        ...(media.synonyms || [])
    ].filter((value): value is string => !!value && value.trim().length > 0);
}

function normalizeTitle(title: string): string {
    return title
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function buildScheduleItems(
    calendar: Record<string, CalendarRelease[]>,
    collectionByTitle: Map<string, ListMedia>
): any[] {
    const results: any[] = [];
    const seen = new Set<string>();

    for (const releases of Object.values(calendar)) {
        if (!Array.isArray(releases)) continue;

        for (const release of releases) {
            const sourceAnime = release?.anime;
            const sourceTitle = sourceAnime?.title || sourceAnime?.title_it || sourceAnime?.title_ja;
            const media = sourceTitle
                ? collectionByTitle.get(normalizeTitle(sourceTitle))
                : undefined;
            const episodeNumber = Number(release?.nextEpisodeNumber);
            const releaseDate = release?.releaseTime ? new Date(release.releaseTime) : null;

            if (!media?.id || !sourceTitle || !Number.isFinite(episodeNumber) ||
                episodeNumber <= 0 || !releaseDate || Number.isNaN(releaseDate.getTime())) {
                continue;
            }

            const language = release.isDub ? "ITA" : "SUB";
            const key = `${media.id}|${episodeNumber}|${language}|${releaseDate.toISOString()}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const totalEpisodes = Number(media.episodes) || 0;
            results.push({
                mediaId: media.id,
                title: `${SOURCE_PREFIX}${sourceTitle} [${language}]`,
                time: releaseDate.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false
                }),
                dateTime: releaseDate.toISOString(),
                image: media.coverImage?.large || media.coverImage?.medium || sourceAnime?.images?.poster,
                episodeNumber,
                isMovie: media.format === "MOVIE",
                isSeasonFinale: totalEpisodes > 0 && episodeNumber === totalEpisodes,
                isAired: !!release.isAired,
                isLate: !!release.isLate
            });
        }
    }

    return results.sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
}
