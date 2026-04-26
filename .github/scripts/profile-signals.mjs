import fs from "node:fs/promises";
import path from "node:path";

const owner = process.env.GITHUB_REPOSITORY_OWNER || process.env.GITHUB_OWNER || "HexAbyss";
const token = process.env.PROFILE_SIGNAL_TOKEN || process.env.GITHUB_TOKEN || "";
const hasUserToken = Boolean(process.env.PROFILE_SIGNAL_TOKEN);
const rootDir = process.cwd();
const outputDir = process.env.PROFILE_SIGNAL_OUTPUT_DIR
  ? path.resolve(process.env.PROFILE_SIGNAL_OUTPUT_DIR)
  : rootDir;
const skipReadmeUpdate = process.env.PROFILE_SIGNAL_SKIP_README_UPDATE === "true";
const mediaDir = path.join(outputDir, "media");
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
await fs.writeFile(path.join(mediaDir, "system-domains-map.svg"), buildSystemDomainsMapSvg(owner));
await fs.writeFile(path.join(mediaDir, "system-domains-planets-legend.svg"), buildSystemDomainsPlanetLegendSvg());
await fs.writeFile(path.join(mediaDir, "system-domains-moons-legend.svg"), buildSystemDomainsMoonLegendSvg());
await fs.writeFile(path.join(mediaDir, "top-languages.svg"), buildTopLanguagesSvg(languageStats, owner, hasUserToken));

if (!skipReadmeUpdate) {
  const timelineMarkdown = buildTimelineMarkdown(repositories);
  await updateReadmeTimeline(timelineMarkdown);
}

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

function getSystemDomainsData() {
  return [
    {
      short: "WS",
      title: "Web Systems",
      angle: 212,
      duration: 76,
      color: "#2F6FEB",
      planetRadius: 42,
      orbitRx: 220,
      orbitRy: 138,
      moonOrbitRx: 72,
      moonOrbitRy: 46,
      moonDuration: 18,
      moons: [
        { name: "Next.js", icon: "next" },
        { name: "React", icon: "react" },
        { name: "TypeScript", icon: "typescript" },
      ],
    },
    {
      short: "LLS",
      title: "Low-Level Systems",
      angle: 28,
      duration: 76,
      color: "#58A6FF",
      planetRadius: 43,
      orbitRx: 220,
      orbitRy: 138,
      moonOrbitRx: 72,
      moonOrbitRy: 46,
      moonDuration: 16,
      moons: [
        { name: "Rust", icon: "rust" },
        { name: "C", icon: "c" },
        { name: "Linux", icon: "linux" },
      ],
    },
    {
      short: "IS",
      title: "Intelligent Systems",
      angle: 270,
      duration: 96,
      color: "#6EA8FE",
      planetRadius: 43,
      orbitRx: 330,
      orbitRy: 220,
      moonOrbitRx: 78,
      moonOrbitRy: 50,
      moonDuration: 15,
      moons: [
        { name: "Python", icon: "python" },
        { name: "OpenAI", icon: "openai" },
        { name: "RAG", icon: "rag" },
      ],
    },
    {
      short: "Infra",
      title: "Infrastructure",
      angle: 90,
      duration: 96,
      color: "#9ECFFF",
      planetRadius: 43,
      orbitRx: 330,
      orbitRy: 220,
      moonOrbitRx: 78,
      moonOrbitRy: 50,
      moonDuration: 17,
      moons: [
        { name: "Docker", icon: "docker" },
        { name: "Vercel", icon: "vercel" },
        { name: "Hostinger", icon: "hostinger" },
      ],
    },
    {
      short: "AS",
      title: "Automation Systems",
      angle: 190,
      duration: 124,
      color: "#7AA2F7",
      planetRadius: 44,
      orbitRx: 470,
      orbitRy: 312,
      moonOrbitRx: 84,
      moonOrbitRy: 54,
      moonDuration: 14,
      moons: [
        { name: "GitHub Actions", icon: "github-actions" },
        { name: "Apps Script", icon: "apps-script" },
        { name: "Webhooks", icon: "webhooks" },
      ],
    },
    {
      short: "DL",
      title: "Data Layer",
      angle: 8,
      duration: 124,
      color: "#4F8FE8",
      planetRadius: 44,
      orbitRx: 470,
      orbitRy: 312,
      moonOrbitRx: 84,
      moonOrbitRy: 54,
      moonDuration: 13,
      moons: [
        { name: "PostgreSQL", icon: "postgresql" },
        { name: "Prisma", icon: "prisma" },
        { name: "SQL", icon: "sql" },
      ],
    },
  ];
}

function buildSystemDomainsMapSvg(login) {
  const width = 1280;
  const height = 1040;
  const center = { x: 640, y: 550 };
  const domains = getSystemDomainsData();
  const orbitPairs = [
    { rx: 220, ry: 138 },
    { rx: 330, ry: 220 },
    { rx: 470, ry: 312 },
  ];

  const stars = buildStarField(`${login}-system-domains-main`, width, height, 84);
  const orbitLines = orbitPairs.map((orbit) => `
  <ellipse cx="${center.x}" cy="${center.y}" rx="${orbit.rx}" ry="${orbit.ry}" fill="none" stroke="rgba(110,168,254,0.18)" stroke-width="1.5" stroke-dasharray="10 12"/>`).join("\n");
  const planets = domains.map((domain) => buildSolarPlanet(domain, center)).join("\n");

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="solarMainBg" x1="0" y1="0" x2="1280" y2="1040" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#050D16"/>
      <stop offset="0.55" stop-color="#0A1A2C"/>
      <stop offset="1" stop-color="#122A45"/>
    </linearGradient>
    <radialGradient id="solarMainGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${center.x} ${center.y}) rotate(90) scale(290)">
      <stop offset="0" stop-color="#F6D365" stop-opacity="0.68"/>
      <stop offset="1" stop-color="#F6D365" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="solarMainCore" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${center.x - 14} ${center.y - 22}) rotate(60) scale(120 120)">
      <stop offset="0" stop-color="#FFF2B2"/>
      <stop offset="0.58" stop-color="#F6D365"/>
      <stop offset="1" stop-color="#E39B27"/>
    </radialGradient>
    <filter id="solarMainSoftGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="32" fill="url(#solarMainBg)"/>
  <rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="24" stroke="rgba(158,207,255,0.14)"/>
  ${stars}
  <text x="44" y="62" fill="#F0F6FC" font-size="31" font-family="Segoe UI, Arial, sans-serif" font-weight="700">System Solar Map</text>
  <text x="44" y="88" fill="#9ECFFF" font-size="15" font-family="Segoe UI, Arial, sans-serif">Large view of the system model: Architecture is fixed at the center, planets orbit slowly, and the moon symbols orbit faster around each domain.</text>
  <circle cx="${center.x}" cy="${center.y}" r="150" fill="url(#solarMainGlow)" opacity="0.88" filter="url(#solarMainSoftGlow)"/>
  ${orbitLines}
  <g>
    <circle cx="${center.x}" cy="${center.y}" r="72" fill="url(#solarMainCore)" stroke="#FFE9A3" stroke-width="2.2"/>
    <circle cx="${center.x}" cy="${center.y}" r="102" fill="none" stroke="rgba(246,211,101,0.18)" stroke-width="1.4"/>
    <text x="${center.x}" y="${center.y + 2}" fill="#08203A" font-size="25" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">Arch</text>
  </g>
  ${planets}
  <text x="44" y="1002" fill="#C9D1D9" font-size="13.5" font-family="Segoe UI, Arial, sans-serif">The solar map is isolated here to maximize readability for both the planet abbreviations and the moon symbols.</text>
</svg>`.trimStart();
}

function buildSystemDomainsPlanetLegendSvg() {
  const width = 1120;
  const height = 280;
  const domains = getSystemDomainsData();
  const entries = [
    { short: "Arch", title: "Architecture", color: "#F6D365" },
    ...domains.map((domain) => ({ short: domain.short, title: domain.title, color: domain.color })),
  ];
  const stars = buildStarField("system-domains-planets-legend", width, height, 28);
  const cards = entries.map((entry, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = 34 + column * 264;
    const y = 96 + row * 92;
    return `
  <g transform="translate(${x} ${y})">
    <rect width="238" height="68" rx="18" fill="#091522" fill-opacity="0.96" stroke="rgba(158,207,255,0.16)"/>
    <circle cx="34" cy="34" r="20" fill="#0B1A2B" stroke="${entry.color}" stroke-width="1.5"/>
    <text x="34" y="34.5" fill="#EAF4FF" font-size="12.5" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">${escapeXml(entry.short)}</text>
    <text x="64" y="34.5" fill="#F0F6FC" font-size="15.5" font-family="Segoe UI, Arial, sans-serif" font-weight="600" dominant-baseline="middle">${escapeXml(entry.title)}</text>
  </g>`;
  }).join("\n");

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="planetLegendBg" x1="0" y1="0" x2="1120" y2="280" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#07111D"/>
      <stop offset="1" stop-color="#0D2238"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="28" fill="url(#planetLegendBg)"/>
  <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="20" stroke="rgba(158,207,255,0.14)"/>
  ${stars}
  <text x="34" y="56" fill="#F0F6FC" font-size="27" font-family="Segoe UI, Arial, sans-serif" font-weight="700">Planet Legend</text>
  <text x="34" y="80" fill="#9ECFFF" font-size="14" font-family="Segoe UI, Arial, sans-serif">Short labels stay inside the planets, and this panel expands them back to the full domain names.</text>
  ${cards}
</svg>`.trimStart();
}

function buildSystemDomainsMoonLegendSvg() {
  const width = 1120;
  const height = 500;
  const domains = getSystemDomainsData();
  const stars = buildStarField("system-domains-moons-legend", width, height, 42);
  const cards = domains.map((domain, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 30 + column * 354;
    const y = 100 + row * 184;
    const rows = domain.moons.map((moon, moonIndex) => {
      const rowY = 50 + moonIndex * 30;
      return `
    <g transform="translate(22 ${rowY})">
      ${buildSolarMoonBadge(moon, 0, 0, 12.5)}
      <text x="28" y="0.5" fill="#DCEBFF" font-size="13.2" font-family="Segoe UI, Arial, sans-serif" dominant-baseline="middle">${escapeXml(moon.name)}</text>
    </g>`;
    }).join("\n");

    return `
  <g transform="translate(${x} ${y})">
    <rect width="324" height="146" rx="18" fill="#091522" fill-opacity="0.96" stroke="rgba(158,207,255,0.16)"/>
    <circle cx="24" cy="24" r="13" fill="#0B1A2B" stroke="${domain.color}" stroke-width="1.4"/>
    <text x="24" y="24.5" fill="#EAF4FF" font-size="11.5" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">${escapeXml(domain.short)}</text>
    <text x="46" y="24.5" fill="#F0F6FC" font-size="14.5" font-family="Segoe UI, Arial, sans-serif" font-weight="600" dominant-baseline="middle">${escapeXml(domain.title)}</text>
    ${rows}
  </g>`;
  }).join("\n");

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="moonLegendBg" x1="0" y1="0" x2="1120" y2="500" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#07111D"/>
      <stop offset="1" stop-color="#0F2741"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="28" fill="url(#moonLegendBg)"/>
  <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="20" stroke="rgba(158,207,255,0.14)"/>
  ${stars}
  <text x="34" y="56" fill="#F0F6FC" font-size="27" font-family="Segoe UI, Arial, sans-serif" font-weight="700">Moon Legend</text>
  <text x="34" y="80" fill="#9ECFFF" font-size="14" font-family="Segoe UI, Arial, sans-serif">The moons keep only the symbols in the solar map, and this panel decodes each symbol back to its technology.</text>
  ${cards}
</svg>`.trimStart();
}

function buildStarField(seedSource, width, height, count) {
  let starSeed = hash(seedSource);
  return Array.from({ length: count }, () => {
    starSeed = seeded(starSeed);
    const x = 24 + (starSeed / 4294967296) * (width - 48);
    starSeed = seeded(starSeed);
    const y = 24 + (starSeed / 4294967296) * (height - 48);
    starSeed = seeded(starSeed);
    const radius = 0.7 + (starSeed / 4294967296) * 1.8;
    starSeed = seeded(starSeed);
    const opacity = 0.14 + (starSeed / 4294967296) * 0.36;
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="#A7D4FF" opacity="${opacity.toFixed(2)}"/>`;
  }).join("\n  ");
}

function buildEllipsePath(rx, ry) {
  return `M ${rx} 0 A ${rx} ${ry} 0 1 1 ${-rx} 0 A ${rx} ${ry} 0 1 1 ${rx} 0`;
}

function buildSolarPlanet(domain, center) {
  const moonAngleStep = 360 / domain.moons.length;
  const moonPath = buildEllipsePath(domain.moonOrbitRx, domain.moonOrbitRy);
  const orbitPath = buildEllipsePath(domain.orbitRx, domain.orbitRy);
  const moons = domain.moons.map((moon, index) => {
    const angle = index * moonAngleStep;
    return `
        <g transform="rotate(${angle})">
          <g>
            <animateMotion dur="${domain.moonDuration}s" repeatCount="indefinite" rotate="0" path="${moonPath}"/>
            ${buildSolarMoonBadge(moon, 0, 0, 13)}
          </g>
        </g>`;
  }).join("\n");

  return `
  <g transform="translate(${center.x} ${center.y}) rotate(${domain.angle})">
    <g>
      <animateMotion dur="${domain.duration}s" repeatCount="indefinite" rotate="0" path="${orbitPath}"/>
      <g>
        <ellipse cx="0" cy="0" rx="${domain.moonOrbitRx}" ry="${domain.moonOrbitRy}" fill="none" stroke="rgba(158,207,255,0.16)" stroke-width="1.2" stroke-dasharray="6 7"/>
        ${moons}
        <circle cx="0" cy="0" r="${domain.planetRadius + 22}" fill="${domain.color}" opacity="0.08" filter="url(#solarMainSoftGlow)"/>
        <circle cx="0" cy="0" r="${domain.planetRadius}" fill="#091522" stroke="${domain.color}" stroke-width="2.1"/>
        <circle cx="-${Math.round(domain.planetRadius * 0.32)}" cy="-${Math.round(domain.planetRadius * 0.38)}" r="${Math.max(5, Math.round(domain.planetRadius * 0.22))}" fill="#FFFFFF" opacity="0.08"/>
        <text x="0" y="1.5" fill="#F0F6FC" font-size="${domain.short.length > 3 ? 14 : 16}" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">${escapeXml(domain.short)}</text>
      </g>
    </g>
  </g>`;
}

function buildSolarMoonBadge(moon, x, y, radius = 10.5) {
  const color = getLanguageColor(moon.name);
  const scale = Number((radius / 10.5).toFixed(3));
  return `
  <g transform="translate(${x} ${y})">
    <circle cx="0" cy="0" r="${radius}" fill="#07111D" stroke="${color}" stroke-width="1.2"/>
    <g transform="scale(${scale})">
      ${buildSolarMoonIcon(moon.icon, color)}
    </g>
  </g>`;
}

function buildSolarMoonIcon(icon, color) {
  switch (icon) {
    case "next":
      return `<text x="0" y="0.5" fill="${color}" font-size="9.5" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">N</text>`;
    case "react":
      return `
    <g stroke="${color}" stroke-width="1" fill="none">
      <ellipse cx="0" cy="0" rx="5.8" ry="2.4"/>
      <ellipse cx="0" cy="0" rx="5.8" ry="2.4" transform="rotate(60)"/>
      <ellipse cx="0" cy="0" rx="5.8" ry="2.4" transform="rotate(120)"/>
    </g>
    <circle cx="0" cy="0" r="1.4" fill="${color}"/>`;
    case "typescript":
      return `
    <rect x="-5" y="-5" width="10" height="10" rx="2" fill="none" stroke="${color}" stroke-width="1"/>
    <text x="0" y="0.4" fill="${color}" font-size="4.5" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">TS</text>`;
    case "python":
      return `
    <path d="M-4.8 -1.8c0-2.1 1.2-3.4 3.4-3.4h2.8c1.9 0 3 1.2 3 2.8v2.3H-1c-1.8 0-3 1.2-3 3v2.1h-1.6c-1.8 0-3.2-1.2-3.2-3.1Z" fill="#4B8BBE"/>
    <circle cx="1.2" cy="-3.1" r="0.75" fill="#EAF4FF"/>
    <path d="M4.8 1.8c0 2.1-1.2 3.4-3.4 3.4h-2.8c-1.9 0-3-1.2-3-2.8V.1H1c1.8 0 3-1.2 3-3v-2.1h1.6c1.8 0 3.2 1.2 3.2 3.1Z" fill="#FFD43B"/>
    <circle cx="-1.2" cy="3.1" r="0.75" fill="#08203A"/>`;
    case "openai":
      return Array.from({ length: 6 }, (_, index) => {
        const angle = (Math.PI * 2 * index) / 6;
        const x = Math.cos(angle) * 4.1;
        const y = Math.sin(angle) * 4.1;
        return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1.85" fill="none" stroke="${color}" stroke-width="1"/>`;
      }).join("");
    case "rag":
      return `
    <rect x="-4.6" y="-4.2" width="7.8" height="2.3" rx="1.1" fill="none" stroke="${color}" stroke-width="1"/>
    <rect x="-2.8" y="-0.9" width="7.8" height="2.3" rx="1.1" fill="none" stroke="${color}" stroke-width="1"/>
    <rect x="-4.6" y="2.4" width="7.8" height="2.3" rx="1.1" fill="none" stroke="${color}" stroke-width="1"/>
    <circle cx="-5.6" cy="-3.1" r="1" fill="${color}"/>
    <circle cx="5.6" cy="0.2" r="1" fill="${color}"/>
    <circle cx="-5.6" cy="3.5" r="1" fill="${color}"/>`;
    case "rust":
      return `
    <circle cx="0" cy="0" r="4.8" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="1.2 2.2"/>
    <text x="0" y="0.5" fill="${color}" font-size="6.4" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">R</text>`;
    case "c":
      return `<text x="0" y="0.5" fill="${color}" font-size="8.6" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">C</text>`;
    case "linux":
      return `
    <rect x="-5.5" y="-4" width="11" height="8" rx="1.8" fill="none" stroke="${color}" stroke-width="1"/>
    <path d="M-2.8 1.8l1.4-1.4-1.4-1.4" stroke="${color}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M1 2.2h3.2" stroke="${color}" stroke-width="1" stroke-linecap="round"/>
    <path d="M-3.8 -5.3h7.6" stroke="${color}" stroke-width="1" stroke-linecap="round"/>`;
    case "docker":
      return `
    <rect x="-5.5" y="-3.8" width="2.5" height="2.5" rx="0.4" fill="${color}"/>
    <rect x="-2.2" y="-3.8" width="2.5" height="2.5" rx="0.4" fill="${color}"/>
    <rect x="1.1" y="-3.8" width="2.5" height="2.5" rx="0.4" fill="${color}"/>
    <rect x="-2.2" y="-0.5" width="2.5" height="2.5" rx="0.4" fill="${color}"/>
    <rect x="1.1" y="-0.5" width="2.5" height="2.5" rx="0.4" fill="${color}"/>
    <path d="M-6 3.2h10.4c1.6 0 2.2-1.2 1.6-2.2-.5-.8-1.3-1.2-2.5-1.2H-2" stroke="${color}" stroke-width="1" stroke-linecap="round" fill="none"/>
    <circle cx="6" cy="2.3" r="0.8" fill="${color}"/>`;
    case "vercel":
      return `<path d="M0 -5.5 5 3.8h-10Z" fill="${color}"/>`;
    case "hostinger":
      return `
    <rect x="-4.8" y="-5" width="2.4" height="10" rx="0.8" fill="${color}"/>
    <rect x="1.4" y="-5" width="2.4" height="10" rx="0.8" fill="${color}"/>
    <rect x="-2" y="-1" width="3.8" height="2" rx="0.8" fill="${color}"/>
    <rect x="-0.3" y="-5" width="1.6" height="10" rx="0.8" fill="#07111D" opacity="0.55"/>`;
    case "github-actions":
      return `
    <circle cx="-3.6" cy="-2.8" r="1.5" fill="none" stroke="${color}" stroke-width="1"/>
    <circle cx="3.6" cy="0" r="1.5" fill="none" stroke="${color}" stroke-width="1"/>
    <circle cx="-1.2" cy="3.5" r="1.5" fill="none" stroke="${color}" stroke-width="1"/>
    <path d="M-2.4 -1.9 2 .4M-2.4 -1.8-.1 2.3" stroke="${color}" stroke-width="1" stroke-linecap="round" fill="none"/>
    <path d="M1.3 -3.9h3.3v3.3" stroke="${color}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    case "apps-script":
      return `
    <path d="M-4.8-4.8h6.5l3.1 3.1V4.8H-4.8Z" fill="none" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>
    <path d="M1.7-4.8v3.1h3.1" fill="none" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>
    <path d="M-2.3-.6 0-2.6 2.3-.6" stroke="${color}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M-2.3 1.8 0 3.8 2.3 1.8" stroke="${color}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    case "webhooks":
      return `
    <circle cx="-3.8" cy="-2.8" r="1.4" fill="none" stroke="${color}" stroke-width="1"/>
    <circle cx="3.8" cy="-1.2" r="1.4" fill="none" stroke="${color}" stroke-width="1"/>
    <circle cx="0.2" cy="3.6" r="1.4" fill="none" stroke="${color}" stroke-width="1"/>
    <path d="M-2.4 -2.3h4.4M-.7 -1.6v4" stroke="${color}" stroke-width="1" stroke-linecap="round" fill="none"/>
    <path d="M1.2 2.6 2.9-.1" stroke="${color}" stroke-width="1" stroke-linecap="round" fill="none"/>`;
    case "postgresql":
      return `
    <ellipse cx="0" cy="-3.4" rx="4.6" ry="1.8" fill="none" stroke="${color}" stroke-width="1"/>
    <path d="M-4.6-3.4v5.8c0 1 2.1 1.8 4.6 1.8s4.6-.8 4.6-1.8v-5.8" fill="none" stroke="${color}" stroke-width="1"/>
    <path d="M-4.6-.4c0 1 2.1 1.8 4.6 1.8S4.6.6 4.6-.4" fill="none" stroke="${color}" stroke-width="1"/>`;
    case "prisma":
      return `<path d="M-3.2 4.8 0-5l4.2 7.6Z" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>`;
    case "sql":
      return `
    <ellipse cx="0" cy="-2.7" rx="4.6" ry="1.8" fill="none" stroke="${color}" stroke-width="1"/>
    <path d="M-4.6-2.7v4.7c0 1 2.1 1.8 4.6 1.8s4.6-.8 4.6-1.8v-4.7" fill="none" stroke="${color}" stroke-width="1"/>
    <text x="0" y="1.2" fill="${color}" font-size="3.8" font-family="Segoe UI, Arial, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="middle">SQL</text>`;
    default:
      return `<circle cx="0" cy="0" r="3" fill="${color}"/>`;
  }
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
    "Next.js": "#F0F6FC",
    React: "#61DAFB",
    OpenAI: "#DCEBFF",
    RAG: "#7AA2F7",
    HTML: "#e34c26",
    CSS: "#563d7c",
    Shell: "#89e051",
    Rust: "#dea584",
    Linux: "#FCC624",
    Docker: "#2496ED",
    Vercel: "#F0F6FC",
    Hostinger: "#7F56D9",
    "GitHub Actions": "#2088FF",
    "Apps Script": "#34A853",
    Webhooks: "#58A6FF",
    PostgreSQL: "#336791",
    Dockerfile: "#384d54",
    Prisma: "#5a67d8",
    SQL: "#9ECFFF",
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
