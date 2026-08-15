# Discord Music Bot

YouTube ve Spotify bağlantılarından Discord ses kanalında müzik çalan Node.js botu.

## Gereksinimler

- Node.js 22+
- `yt-dlp`
- `ffmpeg`
- Discord bot tokenı

## Kurulum

```bash
npm install
cp .env.example .env
```

`.env` dosyasına Discord bot tokenını ekledikten sonra botu başlat:

```bash
npm start
```

## Komutlar

- `!oynat <bağlantı>` — YouTube videosu/playlist'i veya Spotify parçası/albümü/playlist'i çalar.
- `!duraklat` — Oynatmayı duraklatır.
- `!devam` — Oynatmaya devam eder.
- `!geç` — Sıradaki parçaya geçer.
- `!sustur` — Oynatmayı durdurur ve kuyruğu temizler.

YouTube ve Spotify listeleri sona ulaştığında baştan oynatılır.
