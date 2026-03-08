/**
 * GET /api/transcript?v=VIDEO_ID
 *
 * Fetches a YouTube video's captions server-side.
 * Sends a consent cookie to bypass YouTube's cookie wall,
 * extracts the captions XML URL, and returns plain text.
 */

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const videoId = req.query.v;
  if (!videoId) {
    return res.status(400).json({ error: 'Missing video ID (?v=...)' });
  }

  try {
    // -- Fetch video title via oembed (lightweight, no consent issues) --
    let title = '';
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
      );
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        title = oembedData.title || '';
      }
    } catch {}

    // -- Fetch the video page with consent cookie --
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'CONSENT=PENDING+999',
      },
    });

    if (!pageRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch YouTube page.' });
    }

    const html = await pageRes.text();

    // -- Extract caption track URLs from the player response --
    const captionsRegex = /"captionTracks":\s*(\[.*?\])/s;
    const captionsMatch = html.match(captionsRegex);

    if (!captionsMatch) {
      if (!html.includes('"videoId"')) {
        return res.status(404).json({ error: 'Video not found or unavailable.' });
      }
      return res.status(404).json({
        error: 'No transcript available for this video. It may not have captions enabled.',
      });
    }

    // Parse the caption tracks JSON
    const tracksJson = captionsMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    let tracks;
    try {
      tracks = JSON.parse(tracksJson);
    } catch {
      return res.status(500).json({ error: 'Failed to parse caption tracks.' });
    }

    if (!tracks.length) {
      return res.status(404).json({ error: 'No caption tracks found.' });
    }

    // Prefer English captions, fallback to first available
    const track =
      tracks.find((t) => t.languageCode === 'en') ||
      tracks.find((t) => t.languageCode?.startsWith('en')) ||
      tracks[0];

    // -- Fetch the captions XML --
    const captionUrl = track.baseUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const captionRes = await fetch(captionUrl);

    if (!captionRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch captions file.' });
    }

    const xml = await captionRes.text();

    // -- Parse <text> elements into plain text --
    const segments = [];
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = textRegex.exec(xml)) !== null) {
      const text = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, ' ')
        .trim();
      if (text) segments.push(text);
    }

    if (!segments.length) {
      return res.status(404).json({ error: 'Transcript is empty.' });
    }

    return res.status(200).json({ title, transcript: segments.join(' ') });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
