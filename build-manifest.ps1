# Creates an installable Seanime manifest with the TypeScript source embedded.
# Run from this folder: .\build-manifest.ps1
$providerCode = [string](Get-Content -Raw -LiteralPath "$PSScriptRoot\animeunity-it.ts")
$manifest = [ordered]@{
    id = "animeunity-it-local"
    name = "AnimeUnity (IT) - local"
    description = "Public AnimeUnity catalogue and HLS; no DRM, paywall, or login."
    manifestURI = ""
    version = "1.0.0"
    author = "Local"
    type = "onlinestream-provider"
    language = "typescript"
    lang = "it"
    payload = $providerCode
}
$json = $manifest | ConvertTo-Json -Depth 5
# Seanime expects JSON without a UTF-8 BOM.
[System.IO.File]::WriteAllText("$PSScriptRoot\animeunity-it.json", $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Created animeunity-it.json"
