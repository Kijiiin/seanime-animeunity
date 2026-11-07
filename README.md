# AnimeUnity (IT) per Seanime

Provider `onlinestream-provider` in TypeScript per il catalogo pubblico di AnimeUnity (`https://www.animeunity.co`). Implementa le tre funzioni richieste da Seanime: ricerca, elenco episodi e risoluzione delle playlist HLS pubbliche del player VixCloud.

## Flusso verificato il 7 novembre 2026

1. **Ricerca.** `GET /archivio` fornisce token CSRF e cookie di sessione; `POST /archivio/get-animes` riceve JSON (inclusi `title`, `offset` e `dubbed`) e restituisce `records`.
2. **Anime ed episodi.** La pagina `/anime/{id}-{slug}` contiene l'elemento `video-player`, con l'attributo JSON `episodes`. Per cataloghi oltre 120 episodi il sito espone `GET /info_api/{animeId}/1?start_range={n}&end_range={n}`.
3. **Player.** La pagina `/anime/{id}-{slug}/{episodeId}` espone un iframe VixCloud temporaneo. L'iframe pubblico fornisce la master playlist HLS e le sue rendition. Il provider passa a Seanime le rendition `.m3u8` già esposte: non rimuove DRM, non automatizza CAPTCHA, non usa login e non aggira paywall.

## Pubblicazione su GitHub e installazione

1. Crea su GitHub un nuovo repository, ad esempio `seanime-animeunity-it`, lasciandolo pubblico.
2. Carica **tutti i file di questa cartella nella radice del repository**. Non è necessario eseguire `build-manifest.ps1`: `animeunity-it.json` è già pronto e contiene il provider nel campo `payload`.
3. Apri `animeunity-it.json` su GitHub, premi **Raw** e copia l'URL. Avrà questa forma:

   ```text
   https://raw.githubusercontent.com/TUO-UTENTE/seanime-animeunity-it/main/animeunity-it.json
   ```

4. In Seanime vai in **Extensions → Add extension** e incolla quell'URL Raw. In alternativa inseriscilo nella cartella `extensions` della directory dati di Seanime.
5. Abilita **Online streaming**, quindi seleziona **AnimeUnity (IT) - local** fra i provider.

Per testare prima dell'installazione, usa **Extensions → Playground**, scegli **Online Streaming Provider**, incolla `animeunity-it.ts` e prova nell'ordine `search`, `findEpisodes`, `findEpisodeServer`.

### Aggiornamenti tramite GitHub

L'installazione funziona già con il manifest incluso. Per fare in modo che Seanime rilevi gli aggiornamenti automaticamente, dopo aver creato il repository sostituisci il valore vuoto di `manifestURI` in `animeunity-it.json` con il suo URL Raw, poi aumenta `version` a ogni pubblicazione. Esempio:

```json
"manifestURI": "https://raw.githubusercontent.com/TUO-UTENTE/seanime-animeunity-it/main/animeunity-it.json"
```

## Test consigliato

Nella Playground, usa un titolo che AnimeUnity mostra nel proprio archivio. Controlla che `search` restituisca un ID `id-slug`, che `findEpisodes` restituisca soltanto numeri interi e che `findEpisodeServer` esponga una o più fonti `m3u8` con qualità (per esempio 480p/720p/1080p).

## Limiti e sicurezza

- Il sito e VixCloud possono cambiare dominio, markup, token o limitare richieste automatiche: un HTTP 403/429/503 o una playlist senza rendition va trattato come indisponibilità temporanea, non ritentato aggressivamente.
- Gli URL di VixCloud sono a scadenza breve; Seanime deve risolvere nuovamente l'episodio invece di riutilizzarli.
- Il provider tratta solo stream pubblicamente consegnati dal sito. Se un episodio richiedesse DRM, CAPTCHA, login, verifica età o pagamento, non sarà supportato.
- Verifica autonomamente di disporre dei diritti necessari e rispetta termini del sito e normativa locale.
