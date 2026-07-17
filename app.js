import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";

import {
  getDatabase,
  onValue,
  ref
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

import {
  FIREBASE_CONFIG,
  SESSION_ID
} from "./firebase-config.js";

"use strict";

const RENDER_INTERVAL_MS = 100;
const UNSTABLE_AFTER_MS = 15_000;
const RECONNECTING_AFTER_MS = 30_000;

const VIEWER_OFFSET_STORAGE_KEY =
  "backseatLyricsViewerOffsetMs";

const elements = {
  lyrics: document.getElementById("lyrics"),
  connection: document.getElementById("connection"),
  time: document.getElementById("time"),
  progress: document.getElementById("progress"),
  song: document.getElementById("song"),
  saved: document.getElementById("saved"),
  offsetMinus: document.getElementById("offsetMinus"),
  offsetPlus: document.getElementById("offsetPlus"),
  offsetValue: document.getElementById("offsetValue"),
  fullscreen: document.getElementById("fullscreen")
};

let lastLinesKey = "";
let lastIndex = -1;

let viewerOffsetMillis = loadViewerOffset();

let playbackState = null;
let currentSong = null;
let currentSongId = null;

let unsubscribeSong = null;

let controllerPresence = null;
let viewerConnected = false;

let serverTimeOffsetMillis = 0;

let lastAcceptedAnchorServerTime =
  Number.NEGATIVE_INFINITY;

let demoMode = false;

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(
    minimum,
    Math.min(maximum, value)
  );
}

function formatTime(millis) {
  const totalSeconds = Math.max(
    0,
    Math.floor(asFiniteNumber(millis) / 1000)
  );

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function firebaseConfigIsFilledIn() {
  return Boolean(
    FIREBASE_CONFIG?.apiKey &&
    !FIREBASE_CONFIG.apiKey.startsWith("PASTE_") &&
    FIREBASE_CONFIG?.databaseURL &&
    !FIREBASE_CONFIG.databaseURL.includes("PASTE_")
  );
}

function serverNowMillis() {
  return Date.now() + serverTimeOffsetMillis;
}

function loadViewerOffset() {
  const stored = Number(
    localStorage.getItem(
      VIEWER_OFFSET_STORAGE_KEY
    )
  );

  return Number.isFinite(stored)
    ? clamp(stored, -30_000, 30_000)
    : 0;
}

function saveViewerOffset() {
  localStorage.setItem(
    VIEWER_OFFSET_STORAGE_KEY,
    String(viewerOffsetMillis)
  );
}

/* -------------------------------------------------------------------------- */
/* Main UI rendering                                                          */
/* -------------------------------------------------------------------------- */

function update(data) {
  document.body.classList.toggle(
    "light",
    Boolean(data.lightMode)
  );

  document.documentElement.style.setProperty(
    "--accent",
    data.accentColor || "var(--fg)"
  );

  document.documentElement.style.setProperty(
    "--album-glow-strong",
    data.albumGlowStrong ||
      "rgba(255, 255, 255, 0.28)"
  );

  document.documentElement.style.setProperty(
    "--album-glow-soft",
    data.albumGlowSoft ||
      "rgba(255, 255, 255, 0.16)"
  );

  renderLyrics(data);

  elements.connection.textContent =
    data.connectionLabel || "Connecting";

  elements.song.textContent =
    data.songLabel ||
    data.title ||
    "No song playing";

  elements.saved.classList.toggle(
    "visible",
    Boolean(data.lyricsSavedOnDevice)
  );

  updateOffsetValue(
    asFiniteNumber(data.lyricOffsetMillis)
  );

  elements.time.textContent =
    `${formatTime(data.positionMillis)} / ` +
    `${formatTime(data.durationMillis)}`;

  const duration =
    asFiniteNumber(data.durationMillis);

  const progress =
    duration > 0
      ? clamp(
          asFiniteNumber(data.positionMillis) /
            duration,
          0,
          1
        )
      : 0;

  elements.progress.style.width =
    `${(progress * 100).toFixed(1)}%`;
}

function renderLyrics(data) {
  const lines =
    Array.isArray(data.lines) &&
    data.lines.length
      ? data.lines
      : [
          data.currentLine ||
            "Waiting for lyrics"
        ];

  const rawIndex =
    Number(data.currentIndex);

  const index = Math.max(
    0,
    Math.min(
      lines.length - 1,
      Number.isFinite(rawIndex)
        ? Math.trunc(rawIndex)
        : 0
    )
  );

  const linesKey =
    JSON.stringify(lines);

  if (linesKey !== lastLinesKey) {
    const fragment =
      document.createDocumentFragment();

    lines.forEach((line, lineIndex) => {
      const node =
        document.createElement("div");

      node.className = "lyric-line";
      node.dataset.index =
        String(lineIndex);

      node.textContent =
        line || " ";

      fragment.appendChild(node);
    });

    elements.lyrics.replaceChildren(
      fragment
    );

    lastLinesKey = linesKey;
    lastIndex = -1;
  }

  if (index !== lastIndex) {
    const previous =
      elements.lyrics.querySelector(
        ".lyric-line.active"
      );

    if (previous) {
      previous.classList.remove(
        "active"
      );

      previous.style.removeProperty(
        "--active-font-size"
      );
    }

    const active =
      elements.lyrics.querySelector(
        `.lyric-line[data-index="${index}"]`
      );

    if (active) {
      active.classList.add("active");

      fitActiveLyric(active);

      requestAnimationFrame(() => {
        fitActiveLyric(active);

        active.scrollIntoView({
          block: "center",
          behavior: "smooth"
        });
      });
    }

    lastIndex = index;
  }
}

/* -------------------------------------------------------------------------- */
/* Active lyric sizing                                                        */
/* -------------------------------------------------------------------------- */

function fitActiveLyric(node) {
  if (!node) {
    return;
  }

  node.style.removeProperty(
    "--active-font-size"
  );

  const normalSize =
    normalLyricFontSize(node);

  if (!Number.isFinite(normalSize)) {
    return;
  }

  const targetSize =
    normalSize * 1.15;

  const normalLineCount =
    lyricLineCount(
      node,
      normalSize
    );

  if (normalLineCount > 2) {
    node.style.setProperty(
      "--active-font-size",
      `${normalSize.toFixed(2)}px`
    );

    return;
  }

  const targetLineCount =
    lyricLineCount(
      node,
      targetSize
    );

  if (
    normalLineCount === 1 &&
    targetLineCount > 1
  ) {
    node.style.setProperty(
      "--active-font-size",
      `${normalSize.toFixed(2)}px`
    );

    return;
  }

  if (targetLineCount <= 2) {
    node.style.setProperty(
      "--active-font-size",
      `${targetSize.toFixed(2)}px`
    );

    return;
  }

  let low = normalSize;
  let high = targetSize;

  while (high - low > 0.5) {
    const middle =
      (low + high) / 2;

    if (
      lyricLineCount(
        node,
        middle
      ) <= 2
    ) {
      low = middle;
    } else {
      high = middle;
    }
  }

  node.style.setProperty(
    "--active-font-size",
    `${low.toFixed(2)}px`
  );
}

function normalLyricFontSize(node) {
  const parent =
    node.parentElement;

  if (!parent) {
    return Number.NaN;
  }

  const probe =
    node.cloneNode(true);

  probe.className =
    "lyric-line";

  probe.style.position =
    "absolute";

  probe.style.visibility =
    "hidden";

  probe.style.pointerEvents =
    "none";

  probe.style.width =
    `${node.clientWidth}px`;

  probe.style.left =
    "-9999px";

  parent.appendChild(probe);

  const size = Number.parseFloat(
    getComputedStyle(probe).fontSize
  );

  probe.remove();

  return size;
}

function lyricLineCount(
  node,
  fontSize
) {
  const parent =
    node.parentElement;

  if (!parent) {
    return 3;
  }

  const probe =
    node.cloneNode(true);

  probe.className =
    "lyric-line active";

  probe.style.position =
    "absolute";

  probe.style.visibility =
    "hidden";

  probe.style.pointerEvents =
    "none";

  probe.style.width =
    `${node.clientWidth}px`;

  probe.style.left =
    "-9999px";

  probe.style.display =
    "block";

  probe.style.webkitLineClamp =
    "unset";

  probe.style.fontSize =
    `${fontSize.toFixed(2)}px`;

  parent.appendChild(probe);

  const styles =
    getComputedStyle(probe);

  const lineHeight =
    Number.parseFloat(
      styles.lineHeight
    );

  const paddingY =
    (Number.parseFloat(
      styles.paddingTop
    ) || 0) +
    (Number.parseFloat(
      styles.paddingBottom
    ) || 0);

  const textHeight =
    Math.max(
      0,
      probe.scrollHeight -
        paddingY
    );

  const lineCount =
    Number.isFinite(lineHeight) &&
    lineHeight > 0
      ? Math.ceil(
          (textHeight - 0.5) /
            lineHeight
        )
      : 3;

  probe.remove();

  return lineCount;
}

window.addEventListener(
  "resize",
  () => {
    fitActiveLyric(
      elements.lyrics.querySelector(
        ".lyric-line.active"
      )
    );
  }
);

/* -------------------------------------------------------------------------- */
/* Per-viewer lyric offset                                                    */
/* -------------------------------------------------------------------------- */

function updateOffsetValue(
  offsetMillis
) {
  const seconds =
    offsetMillis / 1000;

  const prefix =
    seconds > 0
      ? "+"
      : "";

  elements.offsetValue.textContent =
    `${prefix}${seconds.toFixed(1)}s`;
}

function changeOffset(
  deltaMillis
) {
  viewerOffsetMillis =
    clamp(
      viewerOffsetMillis +
        deltaMillis,
      -30_000,
      30_000
    );

  saveViewerOffset();
}

elements.offsetMinus.addEventListener(
  "click",
  () => changeOffset(-100)
);

elements.offsetPlus.addEventListener(
  "click",
  () => changeOffset(100)
);

/* -------------------------------------------------------------------------- */
/* Fullscreen                                                                 */
/* -------------------------------------------------------------------------- */

function fullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement ||
    null
  );
}

function fullscreenAvailable() {
  return Boolean(
    document.fullscreenEnabled ||
    document.webkitFullscreenEnabled ||
    document.msFullscreenEnabled ||
    document.documentElement
      .requestFullscreen ||
    document.documentElement
      .webkitRequestFullscreen ||
    document.documentElement
      .msRequestFullscreen
  );
}

function updateFullscreenButton() {
  if (!elements.fullscreen) {
    return;
  }

  const active =
    Boolean(fullscreenElement());

  elements.fullscreen.classList.toggle(
    "active",
    active
  );

  elements.fullscreen.setAttribute(
    "aria-label",
    active
      ? "Exit fullscreen"
      : "Enter fullscreen"
  );

  elements.fullscreen.title =
    active
      ? "Exit fullscreen"
      : "Fullscreen";
}

async function toggleFullscreen() {
  const root =
    document.documentElement;

  try {
    if (fullscreenElement()) {
      const exit =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.msExitFullscreen;

      if (exit) {
        await exit.call(document);
      }
    } else {
      const request =
        root.requestFullscreen ||
        root.webkitRequestFullscreen ||
        root.msRequestFullscreen;

      if (request) {
        await request.call(root);
      }
    }
  } catch (error) {
    console.warn(
      "Fullscreen request failed",
      error
    );
  } finally {
    updateFullscreenButton();
  }
}

if (fullscreenAvailable()) {
  elements.fullscreen.addEventListener(
    "click",
    toggleFullscreen
  );

  document.addEventListener(
    "fullscreenchange",
    updateFullscreenButton
  );

  document.addEventListener(
    "webkitfullscreenchange",
    updateFullscreenButton
  );

  document.addEventListener(
    "MSFullscreenChange",
    updateFullscreenButton
  );

  updateFullscreenButton();
} else {
  elements.fullscreen.classList.add(
    "unsupported"
  );

  elements.fullscreen.disabled =
    true;
}

/* -------------------------------------------------------------------------- */
/* Firebase                                                                   */
/* -------------------------------------------------------------------------- */

function startFirebase() {
  const app =
    initializeApp(
      FIREBASE_CONFIG
    );

  const database =
    getDatabase(app);

  const sessionRoot =
    `sessions/${SESSION_ID}`;

  onValue(
    ref(
      database,
      ".info/connected"
    ),
    (snapshot) => {
      viewerConnected =
        snapshot.val() === true;
    }
  );

  onValue(
    ref(
      database,
      ".info/serverTimeOffset"
    ),
    (snapshot) => {
      serverTimeOffsetMillis =
        asFiniteNumber(
          snapshot.val()
        );
    }
  );

  onValue(
    ref(
      database,
      `${sessionRoot}/presence`
    ),
    (snapshot) => {
      controllerPresence =
        snapshot.val() || null;
    }
  );

  onValue(
    ref(
      database,
      `${sessionRoot}/state`
    ),
    (snapshot) => {
      const next =
        snapshot.val();

      if (
        !next ||
        typeof next !== "object"
      ) {
        return;
      }

      const anchor =
        asFiniteNumber(
          next.anchorServerTimeMs,
          Number.NEGATIVE_INFINITY
        );

      /*
       * If an older queued write arrives after a newer
       * playback state, ignore the old write.
       */
      if (
        anchor <
        lastAcceptedAnchorServerTime
      ) {
        return;
      }

      lastAcceptedAnchorServerTime =
        anchor;

      playbackState = next;

      if (
        next.songId &&
        next.songId !== currentSongId
      ) {
        subscribeToSong(
          database,
          String(next.songId)
        );
      }
    },
    (error) => {
      console.error(
        "State listener failed",
        error
      );

      elements.connection.textContent =
        "Permission denied";
    }
  );
}

function subscribeToSong(
  database,
  songId
) {
  if (unsubscribeSong) {
    unsubscribeSong();
  }

  currentSongId = songId;
  currentSong = null;

  lastLinesKey = "";
  lastIndex = -1;

  unsubscribeSong = onValue(
    ref(
      database,
      `songs/${songId}`
    ),
    (snapshot) => {
      currentSong =
        snapshot.val() || null;
    },
    (error) => {
      console.error(
        "Song listener failed",
        error
      );
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Timed lyric processing                                                     */
/* -------------------------------------------------------------------------- */

function normalizedTimedLines(song) {
  const raw =
    song?.lines;

  const values =
    Array.isArray(raw)
      ? raw
      : Object.values(
          raw || {}
        );

  return values
    .map((line) => ({
      startTimeMs:
        asFiniteNumber(
          line?.startTimeMs ??
          line?.timeMs
        ),

      text:
        String(
          line?.text ?? ""
        )
    }))
    .filter(
      (line) =>
        line.text.length > 0
    )
    .sort(
      (first, second) =>
        first.startTimeMs -
        second.startTimeMs
    );
}

/* -------------------------------------------------------------------------- */
/* Playback clock extrapolation                                               */
/* -------------------------------------------------------------------------- */

function estimatedPlaybackPosition(
  state
) {
  const duration =
    Math.max(
      0,
      asFiniteNumber(
        state?.durationMs
      )
    );

  let position =
    Math.max(
      0,
      asFiniteNumber(
        state?.positionMs
      )
    );

  if (state?.isPlaying === true) {
    const anchorTime =
      asFiniteNumber(
        state.anchorServerTimeMs,
        serverNowMillis()
      );

    const elapsed =
      Math.max(
        0,
        serverNowMillis() -
          anchorTime
      );

    const speed =
      Math.max(
        0,
        asFiniteNumber(
          state.playbackSpeed,
          1
        )
      );

    position +=
      elapsed * speed;
  }

  return duration > 0
    ? clamp(
        position,
        0,
        duration
      )
    : position;
}

function lineIndexAtPosition(
  lines,
  positionMillis
) {
  if (!lines.length) {
    return 0;
  }

  let low = 0;
  let high =
    lines.length - 1;

  let answer = 0;

  while (low <= high) {
    const middle =
      Math.floor(
        (low + high) / 2
      );

    if (
      lines[middle]
        .startTimeMs <=
      positionMillis
    ) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return answer;
}

/* -------------------------------------------------------------------------- */
/* Connection label                                                           */
/* -------------------------------------------------------------------------- */

function connectionLabel(state) {
  if (demoMode) {
    return "Demo";
  }

  if (!viewerConnected) {
    return "Offline";
  }

  const anchorTime =
    asFiniteNumber(
      state?.anchorServerTimeMs,
      0
    );

  const age =
    Math.max(
      0,
      serverNowMillis() -
        anchorTime
    );

  if (
    controllerPresence?.online === false ||
    age > RECONNECTING_AFTER_MS
  ) {
    return "Reconnecting";
  }

  if (
    age > UNSTABLE_AFTER_MS
  ) {
    return "Unstable";
  }

  return "Live";
}

/* -------------------------------------------------------------------------- */
/* Frame rendering                                                            */
/* -------------------------------------------------------------------------- */

function renderCloudFrame() {
  if (!playbackState) {
    update({
      lines: [
        "Waiting for the phone"
      ],

      currentIndex: 0,

      title:
        "Waiting for the phone",

      songLabel:
        "Waiting for the phone",

      positionMillis: 0,
      durationMillis: 0,

      lyricOffsetMillis:
        viewerOffsetMillis,

      connectionLabel:
        viewerConnected
          ? "Waiting"
          : "Offline"
    });

    return;
  }

  const timedLines =
    normalizedTimedLines(
      currentSong
    );

  const positionMillis =
    estimatedPlaybackPosition(
      playbackState
    );

  const sharedOffset =
    asFiniteNumber(
      playbackState.lyricOffsetMs
    );

  const effectiveOffset =
    sharedOffset +
    viewerOffsetMillis;

  const lyricPosition =
    positionMillis +
    effectiveOffset;

  const currentIndex =
    lineIndexAtPosition(
      timedLines,
      lyricPosition
    );

  const textLines =
    timedLines.length
      ? timedLines.map(
          (line) => line.text
        )
      : [
          "Loading timed lyrics…"
        ];

  update({
    title:
      playbackState.title ||
      currentSong?.title ||
      "Unknown song",

    artist:
      playbackState.artist ||
      currentSong?.artist ||
      "",

    lines:
      textLines,

    currentIndex:
      timedLines.length
        ? currentIndex
        : 0,

    positionMillis,

    durationMillis:
      asFiniteNumber(
        playbackState.durationMs
      ) ||
      asFiniteNumber(
        currentSong?.durationMs
      ),

    songLabel:
      playbackState.songLabel ||
      [
        playbackState.title,
        playbackState.artist
      ]
        .filter(Boolean)
        .join(" - ") ||
      "Unknown song",

    accentColor:
      playbackState.accentColor ||
      "",

    albumGlowStrong:
      playbackState.albumGlowStrong ||
      "",

    albumGlowSoft:
      playbackState.albumGlowSoft ||
      "",

    lightMode:
      Boolean(
        playbackState.lightMode
      ),

    lyricsSavedOnDevice:
      Boolean(
        playbackState
          .lyricsSavedOnDevice
      ),

    lyricOffsetMillis:
      effectiveOffset,

    connectionLabel:
      connectionLabel(
        playbackState
      )
  });
}

/* -------------------------------------------------------------------------- */
/* Demo fallback                                                              */
/* -------------------------------------------------------------------------- */

const DEMO_LINES = [
  {
    startTimeMs: 0,
    text:
      "Welcome to Back-seat Lyrics"
  },
  {
    startTimeMs: 4000,
    text:
      "The browser advances lyrics using its own clock"
  },
  {
    startTimeMs: 8000,
    text:
      "Firebase only sends occasional playback anchors"
  },
  {
    startTimeMs: 12000,
    text:
      "A brief connection loss will not freeze the lyrics"
  },
  {
    startTimeMs: 16000,
    text:
      "Reconnects correct any accumulated timing error"
  }
];

const DEMO_DURATION_MS =
  20_000;

const DEMO_STARTED_AT =
  Date.now();

function startDemo() {
  demoMode = true;
  viewerConnected = true;

  currentSong = {
    title:
      "Back-seat Lyrics Demo",

    artist:
      "CarLyrics",

    durationMs:
      DEMO_DURATION_MS,

    lines:
      DEMO_LINES
  };

  playbackState = {
    songId: "demo",

    title:
      "Back-seat Lyrics Demo",

    artist:
      "CarLyrics",

    songLabel:
      "Back-seat Lyrics Demo - CarLyrics",

    isPlaying: true,

    positionMs: 0,

    durationMs:
      DEMO_DURATION_MS,

    anchorServerTimeMs:
      DEMO_STARTED_AT,

    playbackSpeed: 1,

    lyricOffsetMs: 0,

    accentColor:
      "#8ab4f8",

    albumGlowStrong:
      "rgba(138, 180, 248, 0.58)",

    albumGlowSoft:
      "rgba(138, 180, 248, 0.34)",

    lightMode: false,

    lyricsSavedOnDevice:
      true
  };

  serverTimeOffsetMillis = 0;
}

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

try {
  if (firebaseConfigIsFilledIn()) {
    startFirebase();
  } else {
    console.warn(
      "Firebase configuration is incomplete. Starting demo mode."
    );

    startDemo();
  }
} catch (error) {
  console.error(
    "Firebase initialization failed",
    error
  );

  elements.connection.textContent =
    "Firebase error";

  startDemo();
}

window.setInterval(
  renderCloudFrame,
  RENDER_INTERVAL_MS
);

renderCloudFrame();