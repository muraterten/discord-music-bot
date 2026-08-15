require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const yts = require('yt-search');
const { getPreview, getTracks } = require('spotify-url-info')(fetch);

const BOT_NAME = 'muratkebaba';
const DEFAULT_VOLUME = 0.8;
const COMMAND_PREFIX = '!';
const MAX_SPOTIFY_TRACKS = 50;
const MAX_YOUTUBE_TRACKS = 100;
const guildStates = new Map();

process.on('unhandledRejection', (error) => console.error('Yakalanmamış promise hatası:', error));
process.on('uncaughtException', (error) => console.error('Yakalanmamış sistem hatası:', error));

if (!process.env.TOKEN) {
  console.error('.env içinde TOKEN bulunamadı. Bot başlatılamadı.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

client.once('clientReady', () => console.log(`${BOT_NAME} hazır`));

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();

  try {
    if (content.startsWith(`${COMMAND_PREFIX}oynat`)) return await handlePlay(message);
    if (content === `${COMMAND_PREFIX}duraklat`) return handlePause(message);
    if (content === `${COMMAND_PREFIX}devam`) return handleResume(message);
    if (content === `${COMMAND_PREFIX}geç`) return handleSkip(message);
    if (content === `${COMMAND_PREFIX}sustur`) return handleStop(message);
  } catch (error) {
    console.error('Komut çalıştırılırken hata oluştu:', error);
    await message.reply(`İşlem başarısız: ${friendlyError(error)}`).catch(() => {});
  }
});

async function handlePlay(message) {
  const input = message.content.trim().split(/\s+/).slice(1).join(' ');

  if (!input) {
    return message.reply('Bir YouTube veya Spotify bağlantısı gir.');
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return message.reply('Önce ses kanalına gir.');

  const tracks = await resolveInput(input);
  if (!tracks.length) return message.reply('Bu bağlantıda çalınabilecek bir parça bulamadım.');

  let state = guildStates.get(message.guild.id);

  if (state && state.voiceChannelId !== voiceChannel.id) {
    cleanupGuild(message.guild.id);
    state = undefined;
  }

  if (!state) {
    state = await createGuildState(message, voiceChannel);
    guildStates.set(message.guild.id, state);
  }

  state.textChannel = message.channel;
  state.queue.push(...tracks);

  const loops = tracks.some((track) => track.loop);
  const suffix = `${tracks.length > 1 ? ` (${tracks.length} parça)` : ''}${loops ? ' — sürekli oynatma açık' : ''}`;
  await message.reply(state.current ? `Kuyruğa eklendi: **${tracks[0].title}**${suffix}` : `Hazırlanıyor: **${tracks[0].title}**${suffix}`);

  if (!state.current) await playNext(message.guild.id);
}

async function createGuildState(message, voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: true
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (error) {
    connection.destroy();
    throw new Error('Ses kanalına bağlanamadım. Discord bağlantısını ve bot izinlerini kontrol et.');
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
  });

  const state = {
    connection,
    player,
    queue: [],
    current: null,
    process: null,
    stream: null,
    textChannel: message.channel,
    voiceChannelId: voiceChannel.id,
    advancing: false
  };

  connection.subscribe(player);
  registerPlayerEvents(player, message.guild.id);
  registerConnectionEvents(connection, message.guild.id);
  return state;
}

async function resolveInput(input) {
  if (isSpotifyUrl(input)) return resolveSpotify(input);
  if (isYoutubePlaylistUrl(input)) return resolveYoutubePlaylist(input);
  if (isYoutubeVideoUrl(input)) return [{ title: 'YouTube parçası', url: input }];
  throw new Error('Geçerli bir YouTube video/playlist veya Spotify parça/albüm/playlist bağlantısı kullan.');
}

async function resolveSpotify(url) {
  const loop = spotifyResourceType(url) !== 'track';
  const preview = await getPreview(url);
  const spotifyTracks = await getTracks(url);
  const sourceTracks = Array.isArray(spotifyTracks) && spotifyTracks.length
    ? spotifyTracks.slice(0, MAX_SPOTIFY_TRACKS)
    : [preview];

  const tracks = [];
  for (const track of sourceTracks) {
    const title = track.name || track.track || track.title;
    const artist = normalizeArtist(track.artists || track.artist);
    if (!title) continue;

    const query = `${artist ? `${artist} - ` : ''}${title} audio`;
    const result = await yts(query);
    const video = result.videos.find((item) => item.seconds > 0 && item.seconds < 60 * 60 * 3);
    if (video) tracks.push({ title: artist ? `${artist} - ${title}` : title, url: video.url, loop });
  }

  return tracks;
}

async function resolveYoutubePlaylist(url) {
  const data = await getYtDlpJson(url);
  const entries = Array.isArray(data.entries) ? data.entries.slice(0, MAX_YOUTUBE_TRACKS) : [];

  return entries
    .filter((entry) => entry?.id || entry?.url || entry?.webpage_url)
    .map((entry) => ({
      title: entry.title || 'YouTube parçası',
      url: entry.webpage_url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : entry.url),
      loop: true
    }));
}

function getYtDlpJson(url) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end', String(MAX_YOUTUBE_TRACKS),
      '--no-warnings',
      url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr = `${stderr}${data}`.slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`YouTube listesi okunamadı: ${stderr.trim() || `yt-dlp kod ${code}`}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('YouTube listesinden geçerli veri alınamadı.'));
      }
    });
  });
}

function normalizeArtist(artists) {
  if (Array.isArray(artists)) {
    return artists.map((artist) => typeof artist === 'string' ? artist : artist?.name).filter(Boolean).join(', ');
  }
  return typeof artists === 'object' ? artists?.name : artists;
}

async function playNext(guildId) {
  const state = guildStates.get(guildId);
  if (!state || state.advancing) return;

  state.advancing = true;
  stopCurrentProcess(state);
  state.current = state.queue.shift() || null;

  if (!state.current) {
    state.advancing = false;
    cleanupGuild(guildId);
    return;
  }

  try {
    const child = createYtDlpProcess(state.current.url);
    state.process = child;
    state.stream = child.stdout;

    const resource = createAudioResource(child.stdout, { inlineVolume: true });
    resource.volume.setVolume(DEFAULT_VOLUME);
    registerProcessEvents(child, guildId);
    state.player.play(resource);
    state.advancing = false;
    await state.textChannel.send(`🎵 Çalıyor: **${state.current.title}**`).catch(() => {});
  } catch (error) {
    console.error('Parça başlatılamadı:', error);
    state.advancing = false;
    await state.textChannel.send(`**${state.current.title}** çalınamadı, sıradaki parçaya geçiyorum.`).catch(() => {});
    state.current = null;
    await playNext(guildId);
  }
}

function handlePause(message) {
  const state = guildStates.get(message.guild.id);
  if (!state?.current) return message.reply('Şu an çalan bir şey yok.');
  return message.reply(state.player.pause() ? `${BOT_NAME} durakladı.` : `${BOT_NAME} zaten duraklamış olabilir.`);
}

function handleResume(message) {
  const state = guildStates.get(message.guild.id);
  if (!state?.current) return message.reply('Devam edecek bir şey yok.');
  return message.reply(state.player.unpause() ? `${BOT_NAME} devam ediyor.` : `${BOT_NAME} devam edemedi.`);
}

function handleSkip(message) {
  const state = guildStates.get(message.guild.id);
  if (!state?.current) return message.reply('Geçilecek bir parça yok.');
  state.player.stop(true);
  return message.reply('Sıradaki parçaya geçiliyor.');
}

function handleStop(message) {
  if (!guildStates.has(message.guild.id)) return message.reply('Şu an çalan bir şey yok.');
  cleanupGuild(message.guild.id);
  return message.reply(`${BOT_NAME} sustu ve kuyruk temizlendi.`);
}

function createYtDlpProcess(url) {
  return spawn('yt-dlp', [
    '-f', 'bestaudio[ext=webm]/bestaudio/best',
    '-o', '-',
    '--no-playlist',
    '--no-warnings',
    '--buffer-size', '64K',
    '--http-chunk-size', '10M',
    '--retries', '5',
    '--fragment-retries', '5',
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function registerProcessEvents(child, guildId) {
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr = `${stderr}${data}`.slice(-2000);
  });
  child.on('error', (error) => {
    console.error('yt-dlp başlatılamadı:', error);
    const state = guildStates.get(guildId);
    if (state?.current) state.player.stop(true);
  });
  child.on('close', (code) => {
    if (code && code !== 0) console.error(`yt-dlp kod ${code}: ${stderr.trim()}`);
  });
}

function registerPlayerEvents(player, guildId) {
  player.on('error', async (error) => {
    console.error('Player hatası:', error);
    const state = guildStates.get(guildId);
    if (!state) return;
    await state.textChannel.send(`Ses akışı kesildi (${friendlyError(error)}). Sıradaki parçaya geçiyorum.`).catch(() => {});
    state.current = null;
    state.advancing = false;
    await playNext(guildId);
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    const state = guildStates.get(guildId);
    if (!state || state.advancing || !state.current) return;
    if (state.current.loop) state.queue.push(state.current);
    state.current = null;
    await playNext(guildId);
  });
}

function registerConnectionEvents(connection, guildId) {
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      const state = guildStates.get(guildId);
      await state?.textChannel.send('Ses kanalı bağlantısı koptu; oynatma durduruldu.').catch(() => {});
      cleanupGuild(guildId);
    }
  });
}

function stopCurrentProcess(state) {
  if (state.stream && !state.stream.destroyed) state.stream.destroy();
  if (state.process && !state.process.killed) state.process.kill('SIGKILL');
  state.stream = null;
  state.process = null;
}

function cleanupGuild(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;
  guildStates.delete(guildId);
  stopCurrentProcess(state);
  try { state.player.stop(true); } catch (error) { console.error('Player durdurulurken hata:', error); }
  try { state.connection.destroy(); } catch (error) { console.error('Voice bağlantısı kapatılırken hata:', error); }
}

function isYoutubeVideoUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname) || url.searchParams.has('list')) return false;
    return hostname === 'youtu.be' ? url.pathname.length > 1 : url.pathname === '/watch' && url.searchParams.has('v');
  } catch {
    return false;
  }
}

function isYoutubePlaylistUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(hostname)
      && url.searchParams.has('list');
  } catch {
    return false;
  }
}

function isSpotifyUrl(value) {
  try {
    const url = new URL(value);
    return ['open.spotify.com', 'play.spotify.com'].includes(url.hostname)
      && /^\/(intl-[^/]+\/)?(track|album|playlist)\//.test(url.pathname);
  } catch {
    return false;
  }
}

function spotifyResourceType(value) {
  try {
    const match = new URL(value).pathname.match(/^\/(?:intl-[^/]+\/)?(track|album|playlist)\//);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function friendlyError(error) {
  const text = error?.message || String(error);
  if (/Sign in to confirm|bot|403/i.test(text)) return 'YouTube erişimi reddetti; yt-dlp/cookie ayarını kontrol et';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

client.login(process.env.TOKEN);
