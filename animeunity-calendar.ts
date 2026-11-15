/**
 * AnimeUnity Calendar for Seanime
 * Version: 0.2.0
 *
 * Uses Seanime's documented Plugin UI API:
 * - $ui.register / ctx.newTray / tray.htm
 * - ctx.fetch
 * - ctx.jobs.poll
 * - $storage
 *
 * Source calendar: https://animeunity.co.it/calendario/
 */

const AU_CALENDAR_URL = "https://animeunity.co.it/calendario/";
const AU_HOME_URL = "https://animeunity.co.it/";
const STORAGE_KEY = "animeunity-calendar-events-v1";
const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

const IT_MONTHS = {
    gen: 0, gennaio: 0,
    feb: 1, febbraio: 1,
    mar: 2, marzo: 2,
    apr: 3, aprile: 3,
    mag: 4, maggio: 4,
    giu: 5, giugno: 5,
    lug: 6, luglio: 6,
    ago: 7, agosto: 7,
    set: 8, settembre: 8,
    ott: 9, ottobre: 9,
    nov: 10, novembre: 10,
    dic: 11, dicembre: 11
};

function auEscapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function auNormalizeText(value) {
    return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t\r\n]+/g, " ")
        .replace(/\s*›\s*/g, " ")
        .trim();
}

function auParseCalendar(html) {
    const $ = LoadDoc(html);
    let text = auNormalizeText($("body").text());

    // The calendar heading contains the year and month, e.g.:
    // "Calendario - novembre, 2026"
    let pageYear = new Date().getFullYear();
    let pageMonth = new Date().getMonth();
    const monthHeading = text.match(/Calendario\s*[-–]\s*([a-zàèéìòù]+)\s*,?\s*(20\d{2})/i);
    if (monthHeading) {
        const m = IT_MONTHS[monthHeading[1].toLowerCase()];
        if (typeof m === "number") pageMonth = m;
        pageYear = Number(monthHeading[2]);
    }

    // Calendar day headings: "Lunedì 9 nov" / "Domenica 15 novembre"
    const dayRegex = /(Domenica|Lunedì|Martedì|Mercoledì|Giovedì|Venerdì|Sabato)\s+(\d{1,2})\s+([a-zàèéìòù]+)/gi;
    const headings = [];
    let match;
    while ((match = dayRegex.exec(text)) !== null) {
        const monthKey = match[3].toLowerCase();
        let month = IT_MONTHS[monthKey];
        if (typeof month !== "number") {
            const short = monthKey.slice(0, 3);
            month = IT_MONTHS[short];
        }
        if (typeof month !== "number") month = pageMonth;

        let year = pageYear;
        // If the month shown crosses the year boundary, infer the adjacent year.
        if (pageMonth === 11 && month === 0) year = pageYear + 1;
        if (pageMonth === 0 && month === 11) year = pageYear - 1;

        headings.push({
            start: match.index,
            end: dayRegex.lastIndex,
            day: Number(match[2]),
            month: month,
            year: year,
            weekday: match[1]
        });
    }

    const events = [];
    for (let i = 0; i < headings.length; i++) {
        const heading = headings[i];
        const sectionEnd = i + 1 < headings.length ? headings[i + 1].start : text.length;
        const section = text.slice(heading.end, sectionEnd);

        // Examples in the source:
        // 15:00 Anime title Episodio 6 · SUB ITA
        // 17:35 Anime title (ITA) Episodio 3
        const eventRegex = /(\d{1,2}:\d{2})\s*(.*?)\s*Episodio\s*(\d+)(?:\s*[·•]\s*(SUB\s*ITA|ITA))?/gi;
        let eventMatch;
        while ((eventMatch = eventRegex.exec(section)) !== null) {
            let title = auNormalizeText(eventMatch[2])
                .replace(/^[›▸▶\-\s]+/, "")
                .replace(/[›▸▶\-\s]+$/, "")
                .trim();

            if (!title || title.length > 220) continue;

            let language = eventMatch[4] || "";
            if (!language) {
                if (/\(ITA\)\s*$/i.test(title)) language = "ITA";
                else language = "SUB ITA";
            }
            title = title.replace(/\s*\(ITA\)\s*$/i, "").trim();

            const date = new Date(heading.year, heading.month, heading.day, 12, 0, 0);
            if (isNaN(date.getTime())) continue;

            const dateKey = [
                date.getFullYear(),
                String(date.getMonth() + 1).padStart(2, "0"),
                String(date.getDate()).padStart(2, "0")
            ].join("-");

            const episode = Number(eventMatch[3]);
            const time = eventMatch[1];
            const id = [dateKey, time, title.toLowerCase(), episode, language].join("|");

            events.push({
                id: id,
                date: dateKey,
                time: time,
                title: title,
                episode: episode,
                language: language.toUpperCase().replace(/\s+/g, " "),
                url: AU_CALENDAR_URL
            });
        }
    }

    // Remove duplicates while preserving order.
    const unique = {};
    const result = [];
    for (let i = 0; i < events.length; i++) {
        if (!unique[events[i].id]) {
            unique[events[i].id] = true;
            result.push(events[i]);
        }
    }
    result.sort(function (a, b) {
        return a.date === b.date
            ? a.time.localeCompare(b.time)
            : a.date.localeCompare(b.date);
    });
    return result;
}

function auFormatDate(dateKey) {
    const parts = dateKey.split("-");
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12);
    return date.toLocaleDateString("it-IT", {
        weekday: "long",
        day: "numeric",
        month: "long"
    });
}

function auRenderHtml(events, status, lastUpdate) {
    let body = "";
    if (!events || events.length === 0) {
        body = '<div class="empty">Nessuna uscita disponibile. Apri il pannello per aggiornare i dati.</div>';
    } else {
        const groups = {};
        events.forEach(function (event) {
            if (!groups[event.date]) groups[event.date] = [];
            groups[event.date].push(event);
        });

        Object.keys(groups).sort().forEach(function (dateKey) {
            body += '<section class="day">';
            body += '<h2>' + auEscapeHtml(auFormatDate(dateKey)) + '</h2>';
            groups[dateKey].forEach(function (event) {
                const langClass = event.language === "ITA" ? "ita" : "sub";
                body += '<article class="event">';
                body += '<div class="time">' + auEscapeHtml(event.time) + '</div>';
                body += '<div class="details">';
                body += '<div class="title">' + auEscapeHtml(event.title) + '</div>';
                body += '<div class="meta">Episodio ' + auEscapeHtml(event.episode) +
                    ' <span class="lang ' + langClass + '">' + auEscapeHtml(event.language) + '</span></div>';
                body += '</div></article>';
            });
            body += '</section>';
        });
    }

    const updated = lastUpdate
        ? new Date(lastUpdate).toLocaleString("it-IT")
        : "Non ancora aggiornato";

    return '<!doctype html><html lang="it"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style>' +
        '*{box-sizing:border-box}body{margin:0;padding:22px;background:#0c0a12;color:#eeeaf5;font:14px/1.5 Inter,system-ui,sans-serif}' +
        '.wrap{max-width:1050px;margin:0 auto}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}' +
        '.brand{display:flex;align-items:center;gap:12px}.logo{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#7c3aed,#c084fc);display:grid;place-items:center;font-weight:800;color:white;font-size:20px}' +
        'h1{font-size:24px;margin:0;font-weight:750;letter-spacing:-.5px}.subtitle{color:#a9a1b7;font-size:12px;margin-top:2px}' +
        '.status{color:#b8adc9;font-size:12px}.source{display:inline-block;color:#d7baff;text-decoration:none;border:1px solid #49306a;padding:8px 12px;border-radius:10px;background:#191323}' +
        '.day{margin:0 0 20px}.day h2{font-size:15px;text-transform:capitalize;color:#d9c4ff;margin:0 0 9px;padding:0 0 8px;border-bottom:1px solid #30253f}' +
        '.event{display:flex;gap:15px;align-items:center;padding:12px 14px;margin:7px 0;border:1px solid #282032;background:#15111d;border-radius:12px}' +
        '.time{min-width:52px;color:#c4a5fd;font-weight:750;font-variant-numeric:tabular-nums}.details{min-width:0;flex:1}.title{font-weight:650;color:#f3effa}.meta{font-size:12px;color:#a69bb5;margin-top:3px}' +
        '.lang{display:inline-block;margin-left:6px;padding:2px 7px;border-radius:6px;font-size:10px;font-weight:750}.sub{background:#30214a;color:#d9baff}.ita{background:#183d35;color:#9ae6c9}' +
        '.empty{padding:30px;text-align:center;color:#a69bb5;background:#15111d;border:1px dashed #493b5b;border-radius:14px}' +
        '.footer{margin-top:24px;padding-top:12px;border-top:1px solid #30253f;color:#82788f;font-size:11px}' +
        '</style></head><body><main class="wrap">' +
        '<header class="top"><div class="brand"><div class="logo">AU</div><div><h1>AnimeUnity Calendar</h1><div class="subtitle">Uscite pubblicate su AnimeUnity · calendario separato</div></div></div>' +
        '<a class="source" href="' + AU_CALENDAR_URL + '" target="_blank" rel="noreferrer">Apri AnimeUnity ↗</a></header>' +
        '<div class="status">' + auEscapeHtml(status) + ' · Ultimo controllo: ' + auEscapeHtml(updated) + '</div>' +
        '<div style="height:18px"></div>' + body +
        '<footer class="footer">Dati letti dal calendario pubblico di AnimeUnity. Gli orari sono quelli indicati dal sito.</footer>' +
        '</main></body></html>';
}

function init() {
    $ui.register(function (ctx) {
        const tray = ctx.newTray({
            iconUrl: "https://animeunity.co.it/favicon.ico",
            withContent: true,
            width: "560px",
            minHeight: "420px"
        });

        let events = $storage.get(STORAGE_KEY) || [];
        let status = events.length
            ? "Calendario caricato dalla cache."
            : "In attesa del primo aggiornamento.";
        let lastUpdate = $storage.get(STORAGE_KEY + "-updated") || "";
        let isLoading = false;

        function render() {
            tray.htm(function () {
                return auRenderHtml(events, status, lastUpdate);
            });
        }

        async function refresh() {
            if (isLoading) return;
            isLoading = true;
            status = "Connessione ad AnimeUnity…";
            render();
            tray.update();

            try {
                const response = await ctx.fetch(AU_CALENDAR_URL, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (compatible; Seanime AnimeUnity Calendar)",
                        "Accept": "text/html,application/xhtml+xml"
                    },
                    timeout: 35
                });

                if (!response || !response.ok) {
                    throw new Error("HTTP " + (response ? response.status : "nessuna risposta"));
                }

                const html = response.text();
                const parsed = auParseCalendar(html);

                if (!parsed.length) {
                    throw new Error("La pagina è stata raggiunta, ma non sono riuscito a riconoscere gli eventi. La struttura del calendario potrebbe essere cambiata.");
                }

                events = parsed;
                lastUpdate = new Date().toISOString();
                status = "Calendario aggiornato · " + events.length + " uscite trovate.";
                $storage.set(STORAGE_KEY, events);
                $storage.set(STORAGE_KEY + "-updated", lastUpdate);
                ctx.toast.success("Calendario AnimeUnity aggiornato");
            } catch (error) {
                status = "Aggiornamento non riuscito: " + String(error);
                ctx.toast.error("AnimeUnity Calendar: " + String(error));
            } finally {
                isLoading = false;
                render();
                tray.update();
            }
        }

        tray.onOpen(function () {
            render();
            refresh();
        });

        // Background refresh while Seanime is running.
        ctx.jobs.poll("animeunity-calendar-refresh", refresh, UPDATE_INTERVAL_MS, {
            immediate: true
        });

        render();
    });
}
