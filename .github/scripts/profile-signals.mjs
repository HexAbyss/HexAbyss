import fs from "node:fs/promises";
import path from "node:path";

const owner = process.env.GITHUB_REPOSITORY_OWNER || process.env.GITHUB_OWNER || "HexAbyss";
const token = process.env.PROFILE_SIGNAL_TOKEN || process.env.GITHUB_TOKEN || "";
const hasUserToken = Boolean(process.env.PROFILE_SIGNAL_TOKEN);
const rootDir = process.cwd();
const mediaDir = path.join(rootDir, "media");
const readmePath = path.join(rootDir, "README.md");

await fs.mkdir(mediaDir, { recursive: true });

const contributionDays = await getContributionDays(owner, token);
const repositories = await getRepositories(owner, token, hasUserToken);
const languageStats = await getLanguageStats(owner, token, hasUserToken);

const latest84Days = normalizeContributionDays(contributionDays).slice(-84);
const weeklyTotals = buildWeeklyTotals(latest84Days, 12);

await fs.writeFile(path.join(mediaDir, "constellation-graph.svg"), buildConstellationSvg(latest84Days, owner));
await fs.writeFile(path.join(mediaDir, "neural-pulse.svg"), buildNeuralPulseSvg(weeklyTotals, owner));
await fs.writeFile(path.join(mediaDir, "architecture-radar.svg"), buildArchitectureRadarSvg(owner));
await fs.writeFile(path.join(mediaDir, "top-languages.svg"), buildTopLanguagesSvg(languageStats, owner, hasUserToken));

const timelineMarkdown = buildTimelineMarkdown(repositories);
await updateReadmeTimeline(timelineMarkdown);

async function getContributionDays(login, authToken) {
  if (!authToken) {
    return buildFallbackContributionDays(login);
  }

  const query = `
    query ($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                date
                weekday
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${authToken}`,
        "Content-Type": "application/json",
        "User-Agent": "profile-signals",
      },
      body: JSON.stringify({ query, variables: { login } }),
    });

    if (!response.ok) {
      return buildFallbackContributionDays(login);
    }

    const payload = await response.json();
    const weeks = payload?.data?.user?.contributionsCollection?.contributionCalendar?.weeks || [];
    const days = weeks.flatMap((week) => week.contributionDays || []);
    return days.length ? days : buildFallbackContributionDays(login);
  } catch {
    return buildFallbackContributionDays(login);
  }
}

async function getRepositories(login, authToken, useAuthenticatedUserEndpoint) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "profile-signals",
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  try {
    const repoEndpoint = useAuthenticatedUserEndpoint
      ? "https://api.github.com/user/repos?affiliation=owner&sort=updated&per_page=6"
      : `https://api.github.com/users/${login}/repos?sort=updated&per_page=6&type=owner`;

    const response = await fetch(repoEndpoint, {
      headers,
    });

    if (!response.ok) {
      return buildFallbackRepositories();
    }

    const repos = await response.json();
    const filtered = repos
      .filter((repo) => !repo.fork)
      .filter((repo) => repo.name.toLowerCase() !== login.toLowerCase())
      .slice(0, 5);

    return filtered.length ? filtered : buildFallbackRepositories();
  } catch {
    return buildFallbackRepositories();
  }
}

async function getLanguageStats(login, authToken, useAuthenticatedUserEndpoint) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "profile-signals",
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  try {
    const repoEndpoint = useAuthenticatedUserEndpoint
      ? "https://api.github.com/user/repos?affiliation=owner&sort=updated&per_page=100"
      : `https://api.github.com/users/${login}/repos?sort=updated&per_page=100&type=owner`;

    const repoResponse = await fetch(repoEndpoint, { headers });
    if (!repoResponse.ok) {
      return buildFallbackLanguageStats();
    }

    const repos = await repoResponse.json();
    const filteredRepos = repos.filter((repo) => !repo.fork);
    const totals = new Map();

    for (const repo of filteredRepos) {
      const languageResponse = await fetch(repo.languages_url, { headers });
      if (!languageResponse.ok) {
        continue;
      }

      const languages = await languageResponse.json();
      for (const [name, bytes] of Object.entries(languages)) {
        totals.set(name, (totals.get(name) || 0) + Number(bytes || 0));
      }
    }

    const totalBytes = [...totals.values()].reduce((sum, value) => sum + value, 0);
    if (!totalBytes) {
      return buildFallbackLanguageStats();
    }

    return [...totals.entries()]
      .map(([name, bytes]) => ({
        name,
        bytes,
        percent: (bytes / totalBytes) * 100,
        color: getLanguageColor(name),
      }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 9);
  } catch {
    return buildFallbackLanguageStats();
  }
}

function normalizeContributionDays(days) {
  if (days.length) {
    return days.map((day) => ({
      date: day.date,
      contributionCount: Number(day.contributionCount || 0),
      weekday: Number(day.weekday || new Date(day.date).getUTCDay()),
    }));
  }

  return buildFallbackContributionDays(owner);
}

function buildWeeklyTotals(days, numberOfWeeks) {
  const paddedDays = [...days];
  while (paddedDays.length < numberOfWeeks * 7) {
    paddedDays.unshift({ contributionCount: 0, date: "", weekday: 0 });
  }

  const relevantDays = paddedDays.slice(-(numberOfWeeks * 7));
  const totals = [];

  for (let index = 0; index < relevantDays.length; index += 7) {
    const week = relevantDays.slice(index, index + 7);
    totals.push(week.reduce((sum, day) => sum + day.contributionCount, 0));
  }

  return totals;
}

function buildConstellationSvg(days, login) {
  const width = 960;
  const height = 420;
  const columns = 12;
  const rows = 7;
  const horizontalGap = 72;
  const verticalGap = 42;
  const startX = 90;
  const startY = 108;

  const activePoints = [];

  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    const column = Math.floor(index / rows);
    const row = index % rows;
    const x = startX + column * horizontalGap;
    const y = startY + row * verticalGap + Math.sin((column + 1) * 0.55) * 8;
    const radius = 1.5 + Math.min(day.contributionCount, 16) * 0.22;
    const opacity = day.contributionCount > 0 ? Math.min(0.98, 0.28 + day.contributionCount / 12) : 0.14;

    activePoints.push({ x, y, radius, opacity, count: day.contributionCount });
  }

  const lines = [];
  for (let index = 0; index < activePoints.length - 1; index += 1) {
    const current = activePoints[index];
    const next = activePoints[index + 7] || activePoints[index + 1];
    if (!next) {
      continue;
    }
    if (current.count === 0 && next.count === 0) {
      continue;
    }

    const strength = Math.max(current.opacity, next.opacity) * 0.55;
    lines.push(`<path d="M ${current.x} ${current.y} Q ${(current.x + next.x) / 2} ${(current.y + next.y) / 2 - 10} ${next.x} ${next.y}" stroke="rgba(110,168,254,${strength.toFixed(2)})" stroke-width="1.2" fill="none" stroke-linecap="round"/>`);
  }

  const stars = activePoints.map((point) => {
    return [
      `<circle cx="${point.x}" cy="${point.y}" r="${(point.radius * 2.8).toFixed(2)}" fill="rgba(47,111,235,${(point.opacity * 0.18).toFixed(2)})" filter="url(#blur)"/>`,
      `<circle cx="${point.x}" cy="${point.y}" r="${point.radius.toFixed(2)}" fill="rgba(234,244,255,${point.opacity.toFixed(2)})"/>`,
    ].join("");
  }).join("\n");

  const total = days.reduce((sum, day) => sum + day.contributionCount, 0);

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="960" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#08101A"/>
      <stop offset="0.55" stop-color="#0D1B2A"/>
      <stop offset="1" stop-color="#103A63"/>
    </linearGradient>
    <linearGradient id="grid" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2F6FEB" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#6EA8FE" stop-opacity="0.04"/>
    </linearGradient>
    <filter id="blur">
      <feGaussianBlur stdDeviation="8"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="28" fill="url(#bg)"/>
  <circle cx="760" cy="70" r="120" fill="#2F6FEB" opacity="0.12" filter="url(#blur)"/>
  <circle cx="180" cy="330" r="130" fill="#6EA8FE" opacity="0.08" filter="url(#blur)"/>
  <path d="M48 82H912" stroke="url(#grid)" stroke-width="1"/>
  <text x="52" y="52" fill="#E6F1FF" font-size="28" font-family="Segoe UI, Arial, sans-serif" font-weight="700">Constellation Graph</text>
  <text x="52" y="74" fill="#9ECFFF" font-size="14" font-family="Segoe UI, Arial, sans-serif">Contribution signals rendered as a live engineering sky for ${escapeXml(login)}</text>
  ${lines.join("\n")}
  ${stars}
  <text x="52" y="390" fill="#C9D1D9" font-size="13" font-family="Segoe UI, Arial, sans-serif">Last 84 days · ${total} visible contribution impulses</text>
  <text x="742" y="390" fill="#6EA8FE" font-size="13" font-family="Segoe UI, Arial, sans-serif">architecture • systems • intelligence</text>
</svg>`.trimStart();
}

function buildNeuralPulseSvg(weeklyTotals, login) {
  const width = 960;
  const height = 320;
  const paddingX = 54;
  const paddingTop = 72;
  const paddingBottom = 54;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingTop - paddingBottom;
  const maxValue = Math.max(...weeklyTotals, 1);

  const points = weeklyTotals.map((value, index) => {
    const x = paddingX + (innerWidth / Math.max(weeklyTotals.length - 1, 1)) * index;
    const y = paddingTop + innerHeight - (value / maxValue) * (innerHeight - 12);
    return { x, y, value };
  });

  const pathData = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaData = `${pathData} L ${points[points.length - 1].x.toFixed(2)} ${(height - paddingBottom).toFixed(2)} L ${points[0].x.toFixed(2)} ${(height - paddingBottom).toFixed(2)} Z`;

  const grid = Array.from({ length: 4 }, (_, index) => {
    const y = paddingTop + (innerHeight / 3) * index;
    return `<line x1="${paddingX}" y1="${y.toFixed(2)}" x2="${width - paddingX}" y2="${y.toFixed(2)}" stroke="rgba(110,168,254,0.12)" stroke-width="1"/>`;
  }).join("\n");

  const dots = points.map((point) => `
    <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="5.5" fill="#EAF4FF" opacity="0.95"/>
    <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="14" fill="#2F6FEB" opacity="0.16" filter="url(#glow)"/>
  `).join("\n");

  const peak = Math.max(...weeklyTotals, 0);

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="pulseBg" x1="0" y1="0" x2="960" y2="320" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#07121E"/>
      <stop offset="1" stop-color="#0E2740"/>
    </linearGradient>
    <linearGradient id="pulseLine" x1="54" y1="72" x2="906" y2="246" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6EA8FE"/>
      <stop offset="1" stop-color="#2F6FEB"/>
    </linearGradient>
    <linearGradient id="pulseArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2F6FEB" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#2F6FEB" stop-opacity="0.02"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="8"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="28" fill="url(#pulseBg)"/>
  <text x="52" y="48" fill="#E6F1FF" font-size="26" font-family="Segoe UI, Arial, sans-serif" font-weight="700">Neural Pulse</text>
  <text x="52" y="68" fill="#9ECFFF" font-size="14" font-family="Segoe UI, Arial, sans-serif">Weekly contribution voltage for ${escapeXml(login)}</text>
  ${grid}
  <path d="${areaData}" fill="url(#pulseArea)"/>
  <path d="${pathData}" stroke="url(#pulseLine)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  <path d="${pathData}" stroke="#EAF4FF" stroke-opacity="0.75" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
  <text x="52" y="286" fill="#C9D1D9" font-size="13" font-family="Segoe UI, Arial, sans-serif">12-week pulse window</text>
  <text x="782" y="286" fill="#6EA8FE" font-size="13" font-family="Segoe UI, Arial, sans-serif">peak intensity: ${peak}</text>
</svg>`.trimStart();
}

function buildArchitectureRadarSvg(login) {
  const width = 620;
  const height = 620;
  const cx = width / 2;
  const cy = height / 2 + 12;
  const maxRadius = 198;
  const axes = [
    { label: "Frontend", value: 0.9 },
    { label: "Backend", value: 0.94 },
    { label: "AI", value: 0.87 },
    { label: "Automation", value: 0.96 },
    { label: "Infra", value: 0.84 },
    { label: "Integration", value: 0.93 },
  ];

  const rings = [0.2, 0.4, 0.6, 0.8, 1];
  const angleStep = (Math.PI * 2) / axes.length;

  const ringPolygons = rings.map((ring) => {
    const points = axes.map((_, index) => {
      const angle = -Math.PI / 2 + angleStep * index;
      const x = cx + Math.cos(angle) * maxRadius * ring;
      const y = cy + Math.sin(angle) * maxRadius * ring;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    return `<polygon points="${points}" fill="none" stroke="rgba(110,168,254,${0.10 + ring * 0.18})" stroke-width="1"/>`;
  }).join("\n");

  const axisLines = axes.map((_, index) => {
    const angle = -Math.PI / 2 + angleStep * index;
    const x = cx + Math.cos(angle) * maxRadius;
    const y = cy + Math.sin(angle) * maxRadius;
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(110,168,254,0.24)" stroke-width="1"/>`;
  }).join("\n");

  const dataPoints = axes.map((axis, index) => {
    const angle = -Math.PI / 2 + angleStep * index;
    const x = cx + Math.cos(angle) * maxRadius * axis.value;
    const y = cy + Math.sin(angle) * maxRadius * axis.value;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const labels = axes.map((axis, index) => {
    const angle = -Math.PI / 2 + angleStep * index;
    const x = cx + Math.cos(angle) * (maxRadius + 42);
    const y = cy + Math.sin(angle) * (maxRadius + 42);
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" fill="#C9D1D9" font-size="14" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Arial, sans-serif">${axis.label}</text>`;
  }).join("\n");

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="radarBg" x1="0" y1="0" x2="620" y2="620" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#08101A"/>
      <stop offset="1" stop-color="#102A43"/>
    </linearGradient>
    <linearGradient id="radarFill" x1="120" y1="80" x2="500" y2="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6EA8FE" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#2F6FEB" stop-opacity="0.18"/>
    </linearGradient>
    <filter id="radarGlow">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="28" fill="url(#radarBg)"/>
  <text x="42" y="52" fill="#E6F1FF" font-size="26" font-family="Segoe UI, Arial, sans-serif" font-weight="700">Architecture Radar</text>
  <text x="42" y="72" fill="#9ECFFF" font-size="14" font-family="Segoe UI, Arial, sans-serif">Current engineering profile shape for ${escapeXml(login)}</text>
  ${ringPolygons}
  ${axisLines}
  <polygon points="${dataPoints}" fill="url(#radarFill)" stroke="#6EA8FE" stroke-width="2.2"/>
  <polygon points="${dataPoints}" fill="#2F6FEB" opacity="0.18" filter="url(#radarGlow)"/>
  ${axes.map((axis, index) => {
    const angle = -Math.PI / 2 + angleStep * index;
    const x = cx + Math.cos(angle) * maxRadius * axis.value;
    const y = cy + Math.sin(angle) * maxRadius * axis.value;
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5" fill="#EAF4FF"/>`;
  }).join("\n")}
  ${labels}
</svg>`.trimStart();
}

function buildTopLanguagesSvg(languageStats, login, includesPrivateRepos) {
  const width = 540;
  const height = 170;
  const cardX = 10;
  const cardY = 8;
  const cardWidth = 520;
  const cardHeight = 154;
  const barX = 24;
  const barY = 48;
  const barWidth = 492;
  const barHeight = 10;
  const visibleStats = languageStats.slice(0, 9);
  const totalVisiblePercent = visibleStats.reduce((sum, language) => sum + language.percent, 0);
  const normalizedStats = visibleStats.map((language) => ({
    ...language,
    normalizedPercent: totalVisiblePercent > 0 ? (language.percent / totalVisiblePercent) * 100 : 0,
  }));
  const legendColumns = [28, 190, 352];
  const legendPercentX = [166, 328, 490];
  const legendBaseY = 82;
  const legendRowGap = 24;

  let segmentStart = barX;
  const segments = normalizedStats.map((language, index) => {
    const isLast = index === normalizedStats.length - 1;
    const rawWidth = (language.normalizedPercent / 100) * barWidth;
    const segmentWidth = isLast ? barX + barWidth - segmentStart : Math.max(6, rawWidth);
    const segment = `<rect x="${segmentStart.toFixed(2)}" y="${barY}" width="${segmentWidth.toFixed(2)}" height="${barHeight}" fill="${language.color}"/>`;
    segmentStart += segmentWidth;
    return segment;
  }).join("\n    ");

  const legendEntries = normalizedStats.map((language, index) => {
    const column = Math.floor(index / 3);
    const row = index % 3;
    const x = legendColumns[column];
    const y = legendBaseY + row * legendRowGap;
    const label = escapeXml(truncateLegendLabel(language.name, 12));
    const percent = `${language.percent.toFixed(1)}%`;
    return `
  <circle cx="${x}" cy="${y}" r="4" fill="${language.color}"/>
  <text x="${x + 14}" y="${y + 1}" fill="#F0F6FC" font-size="12.5" font-family="Segoe UI, Arial, sans-serif" font-weight="600" dominant-baseline="middle">${label}</text>
  <text x="${legendPercentX[column]}" y="${y + 1}" fill="#8B949E" font-size="12" font-family="Segoe UI, Arial, sans-serif" dominant-baseline="middle" text-anchor="end">${percent}</text>`;
  }).join("\n");

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="8" fill="#0D1117"/>
  <text x="24" y="29" fill="#F0F6FC" font-size="14" font-family="Segoe UI, Arial, sans-serif" font-weight="700">Languages</text>
  <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="#21262D"/>
  <clipPath id="langBarClip">
    <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4"/>
  </clipPath>
  <g clip-path="url(#langBarClip)">
    ${segments}
  </g>
  ${legendEntries}
</svg>`.trimStart();
}

function buildTimelineMarkdown(repositories) {
  return repositories.map((repo) => {
    const updatedAt = formatDate(repo.updated_at || repo.updatedAt || new Date().toISOString());
    const description = repo.description ? cleanText(repo.description) : "No public description yet.";
    const language = repo.language || repo.primaryLanguage?.name || "stack in motion";
    return `- **[${repo.name}](${repo.html_url || repo.url})** — ${description} • ${language} • updated ${updatedAt}.`;
  }).join("\n");
}

async function updateReadmeTimeline(timelineMarkdown) {
  const readme = await fs.readFile(readmePath, "utf8");
  const startMarker = "<!--live_timeline:start-->";
  const endMarker = "<!--live_timeline:end-->";
  const replacement = `${startMarker}\n${timelineMarkdown}\n${endMarker}`;
  const updated = readme.replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`), replacement);
  await fs.writeFile(readmePath, updated);
}

function buildFallbackContributionDays(seedSource) {
  const results = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 119);
  let seed = hash(seedSource);

  for (let index = 0; index < 120; index += 1) {
    seed = seeded(seed);
    const contributionCount = Math.floor((seed / 4294967296) * 14);
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    results.push({
      contributionCount,
      date: date.toISOString().slice(0, 10),
      weekday: date.getUTCDay(),
    });
  }

  return results;
}

function buildFallbackRepositories() {
  return [
    {
      name: "OmniVoice",
      description: "Voice cloning stack with Docker delivery, web UI and CPU or GPU execution paths.",
      html_url: "https://github.com/HexAbyss/OmniVoice",
      language: "Python",
      updated_at: new Date().toISOString(),
    },
    {
      name: "Atlas",
      description: "Local agent architecture for automating system workflows and operational routines.",
      html_url: "https://github.com/HexAbyss/Atlas",
      language: "TypeScript",
      updated_at: new Date().toISOString(),
    },
    {
      name: "Sophya",
      description: "Remote intelligence layer designed to integrate with Atlas and orchestrate AI behavior.",
      html_url: "https://github.com/HexAbyss/Sophya",
      language: "TypeScript",
      updated_at: new Date().toISOString(),
    },
  ];
}

function buildFallbackLanguageStats() {
  return [
    { name: "TypeScript", bytes: 33, percent: 33, color: getLanguageColor("TypeScript") },
    { name: "Python", bytes: 21, percent: 21, color: getLanguageColor("Python") },
    { name: "JavaScript", bytes: 14, percent: 14, color: getLanguageColor("JavaScript") },
    { name: "HTML", bytes: 9, percent: 9, color: getLanguageColor("HTML") },
    { name: "CSS", bytes: 7, percent: 7, color: getLanguageColor("CSS") },
    { name: "Shell", bytes: 5, percent: 5, color: getLanguageColor("Shell") },
    { name: "Rust", bytes: 4, percent: 4, color: getLanguageColor("Rust") },
    { name: "Dockerfile", bytes: 4, percent: 4, color: getLanguageColor("Dockerfile") },
    { name: "Markdown", bytes: 3, percent: 3, color: getLanguageColor("Markdown") },
  ];
}

function getLanguageColor(name) {
  const colors = {
    TypeScript: "#3178c6",
    JavaScript: "#f1e05a",
    Python: "#3572A5",
    HTML: "#e34c26",
    CSS: "#563d7c",
    Shell: "#89e051",
    Rust: "#dea584",
    Dockerfile: "#384d54",
    Prisma: "#5a67d8",
    MDX: "#1b1f24",
    Markdown: "#083fa1",
    Go: "#00ADD8",
    Java: "#b07219",
    C: "#555555",
    "C++": "#f34b7d",
    "C#": "#178600",
    SCSS: "#c6538c",
    Vue: "#41b883",
    Svelte: "#ff3e00",
    TSX: "#3178c6",
    JSX: "#61dafb",
    Kotlin: "#A97BFF",
    Swift: "#F05138",
    PHP: "#4F5D95",
  };

  if (colors[name]) {
    return colors[name];
  }

  const fallbackPalette = ["#2F6FEB", "#6EA8FE", "#58A6FF", "#9ECFFF", "#1F6FEB", "#7aa2f7"];
  return fallbackPalette[hash(name) % fallbackPalette.length];
}

function truncateLegendLabel(value, maxLength = 12) {
  const normalized = String(value).trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function hash(value) {
  let output = 2166136261;
  for (const character of value) {
    output ^= character.charCodeAt(0);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

function seeded(value) {
  return (Math.imul(value, 1664525) + 1013904223) >>> 0;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}

function cleanText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
