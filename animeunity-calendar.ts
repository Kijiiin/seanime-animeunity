// AnimeUnity Calendar for Seanime
// First experimental build for Seanime 3.10.x
// Source: https://animeunity.co.it/calendario/

const AU_URL = "https://animeunity.co.it/calendario/";
const DAYS = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

function cleanText(value) {
    return String(value || "")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();
}

function parseCalendar(html) {
    const doc = LoadDoc(html);
    const text = cleanText(doc("body").text());
    const events = [];
    const monthNames = "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre";
    const dayPattern = new RegExp("(Domenica|Lunedì|Martedì|Mercoledì|Giovedì|Venerdì|Sabato)\\s+(\\d{1,2})\\s+(" + monthNames + ")", "gi");
    const headers = [];
    let match;
    while ((match = dayPattern.exec(text)) !== null) {
        headers.push({ index: match.index, end: dayPattern.lastIndex, day: match[1], date: Number(match[2]), month: match[3] });
    }

    const year = new Date().getFullYear();
    const monthIndex = {
        gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
        luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11
    };

    for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        const section = text.slice(h.end, i + 1 < headers.length ? headers[i + 1].index : text.length);
        const date = new Date(year, monthIndex[h.month.toLowerCase()], h.date);
        const eventPattern = /(\d{1,2}:\d{2})\s*(.*?)\s*Episodio\s*(\d+)\s*[·•]\s*(SUB\s*ITA|ITA)/gi;
        let ev;
        while ((ev = eventPattern.exec(section)) !== null) {
            const title = cleanText(ev[2]).replace(/[›▸▶]+$/g, "").trim();
            if (!title || title.length > 180) continue;
            events.push({
                id: [date.getFullYear(), date.getMonth(), date.getDate(), ev[1], title, ev[3], ev[4]].join("|"),
                title,
                episode: Number(ev[3]),
                language: ev[4].toUpperCase().replace(/\s+/g, " "),
                time: ev[1],
                date: date.toISOString().slice(0, 10),
                day: h.day
            });
        }
    }
    return events;
}

function init() {
    $ui.register((ctx) => {
        const eventsState = ctx.state([]);
        const statusState = ctx.state("Premi Aggiorna per caricare il calendario.");
        const loadingState = ctx.state(false);
        const selectedDayState = ctx.state("");

        const tray = ctx.newTray({
            tooltipText: "AnimeUnity Calendar",
            iconUrl: "https://animeunity.co.it/favicon.ico",
            withContent: true
        });

        async function refresh() {
            if (loadingState.get()) return;
            loadingState.set(true);
            statusState.set("Lettura del calendario AnimeUnity…");
            try {
                const response = await ctx.fetch(AU_URL);
                if (!response || response.status < 200 || response.status >= 300) {
                    throw new Error("Risposta HTTP non valida");
                }
                const html = await response.text();
                const events = parseCalendar(html);
                eventsState.set(events);
                selectedDayState.set("");
                statusState.set(events.length
                    ? "Aggiornato: " + events.length + " uscite trovate."
                    : "Pagina letta, ma non sono riuscito a riconoscere le uscite. Il sito potrebbe aver cambiato struttura.");
                $storage.set("lastUpdate", new Date().toISOString());
                $storage.set("events", events);
            } catch (error) {
                statusState.set("Errore nel caricamento: " + String(error));
                ctx.toast.error("Impossibile leggere il calendario AnimeUnity");
            } finally {
                loadingState.set(false);
            }
        }

        function render() {
            const events = eventsState.get() || [];
            const grouped = {};
            events.forEach((event) => {
                if (!grouped[event.date]) grouped[event.date] = [];
                grouped[event.date].push(event);
            });

            const dayKeys = Object.keys(grouped).sort();
            const children = [
                tray.text("AnimeUnity Calendar"),
                tray.text(statusState.get()),
                tray.button({ label: loadingState.get() ? "Aggiornamento…" : "Aggiorna calendario", onClick: "refresh" })
            ];

            if (dayKeys.length === 0) {
                children.push(tray.text("Nessuna uscita caricata. Premi Aggiorna calendario."));
            } else {
                dayKeys.forEach((key) => {
                    const date = new Date(key + "T12:00:00");
                    children.push(tray.text(DAYS[date.getDay()] + " " + date.toLocaleDateString("it-IT")));
                    grouped[key].sort((a, b) => a.time.localeCompare(b.time)).forEach((event) => {
                        children.push(tray.text(event.time + "  " + event.title));
                        children.push(tray.text("Episodio " + event.episode + " · " + event.language));
                    });
                });
            }
            const lastUpdate = $storage.get("lastUpdate");
            if (lastUpdate) children.push(tray.text("Ultimo controllo: " + new Date(lastUpdate).toLocaleString("it-IT")));
            return tray.stack(children);
        }

        ctx.registerEventHandler("refresh", refresh);

        const cached = $storage.get("events");
        if (cached && cached.length) {
            eventsState.set(cached);
            statusState.set("Calendario salvato. Premi Aggiorna per verificare le nuove uscite.");
        }
        tray.render(render);
        tray.onOpen(() => {
            if (!eventsState.get().length) refresh();
        });
    });
}
