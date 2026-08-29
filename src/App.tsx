import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
// PeerJS assigns a random id when constructed with an empty string.
import Peer, { type DataConnection } from "peerjs";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  Ban,
  BellRing,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Database,
  DoorOpen,
  Download,
  Ellipsis,
  Eraser,
  EyeOff,
  FileUp,
  Image as ImageIcon,
  Info,
  Link as LinkIcon,
  ListChecks,
  LockKeyhole,
  Mail,
  MessageCircle,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  ShieldOff,
  Smile,
  SmartphoneNfc,
  Sun,
  Trash2,
  UserPlus,
  Users,
  UserX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

/* ---------------------------------- types --------------------------------- */

type Profile = {
  id: string;
  peerId: string;
  nickname: string;
  bio: string;
  color: string;
  createdAt: number;
  avatarImage?: string | null;
};

type Friend = Profile & {
  addedAt: number;
  relation: "active" | "blocked" | "blockedByThem";
  deleteRequest?: { id: string; direction: "in" | "out"; requestedAt: number };
};

type MessageKind = "text" | "sticker" | "deletion-log";

type ChatMessage = {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  kind: MessageKind;
  sentAt: number;
  status: "queued" | "sent";
  pendingFor?: string[];
};

type Group = {
  id: string;
  name: string;
  creatorId: string;
  members: Profile[];
  createdAt: number;
};

type ControlAction = "group-sync" | "group-delete" | "group-leave" | "messages-deleted" | "friend-removed";

type DeletionPayload = {
  chatId: string;
  scope: "direct" | "group";
  entries: { id: string; sentAt: number }[];
};

type OutboxItem = {
  id: string;
  ownerId: string;
  toId: string;
  toPeerId: string;
  action: ControlAction;
  payload: unknown;
};

type GroupDeletionJob = {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string;
  entries: { id: string; sentAt: number }[];
  pendingFor: string[];
  createdAt: number;
};

type Tombstone = {
  accountId: string;
  peerId: string;
  targets: { id: string; peerId: string }[];
};

type LocalData = {
  version: 1;
  accounts: Profile[];
  friends: Record<string, Friend[]>;
  messages: Record<string, Record<string, ChatMessage[]>>;
  groups: Record<string, Group[]>;
  receipts: Record<string, Record<string, number>>;
  presence: Record<string, Record<string, number>>;
  groupDeletions: Record<string, GroupDeletionJob[]>;
  outbox: OutboxItem[];
  tombstones: Tombstone[];
};

type Drafts = Record<string, Record<string, string>>;
type ReadState = Record<string, Record<string, number>>;
type Theme = "light" | "dark" | "system";

type TransferPayload = {
  kind: "chsyp-transfer";
  version: 1;
  data: LocalData;
  drafts: Drafts;
  readState: ReadState;
  theme: Theme;
  linksEnabled: boolean;
  longMessages: boolean;
  showFriendIcons: boolean;
};

type TransferWire =
  | { t: "hello" }
  | { t: "begin"; total: number }
  | { t: "chunk"; i: number; s: string }
  | { t: "end" }
  | { t: "ack" };

type Hop = { hops: number; via: string };

type Packet =
  | { type: "hello"; profile: Profile; hidden?: boolean; avatarImage?: string | null }
  | { type: "chat"; message: ChatMessage }
  | ({ type: "group-chat"; message: ChatMessage; group: Group } & Hop)
  | ({ type: "group-control"; eventId: string; senderId: string; action: ControlAction; payload: unknown; group: Group } & Hop)
  | { type: "message-ack"; messageId: string }
  | { type: "typing"; senderId: string; chatId: string; scope: "direct" | "group" }
  | { type: "visibility"; senderId: string; hidden: boolean }
  | { type: "avatar-share"; senderId: string; avatarImage: string | null }
  | { type: "read"; senderId: string; chatId: string; upTo: number }
  | { type: "friend-block"; senderId: string }
  | { type: "friend-unblock"; senderId: string }
  | { type: "delete-request"; requestId: string; senderId: string }
  | { type: "delete-reject"; requestId: string; senderId: string }
  | { type: "delete-confirm"; requestId: string; senderId: string }
  | { type: "purge-request"; requestId: string; senderId: string }
  | { type: "purge-reject"; requestId: string; senderId: string }
  | { type: "purge-confirm"; requestId: string; senderId: string }
  | { type: "control"; eventId: string; senderId: string; action: ControlAction; payload: unknown }
  | { type: "control-ack"; eventId: string }
  | { type: "account-deleted"; senderId: string; peerId: string }
  | { type: "account-deleted-ack"; senderId: string }
  | { type: "invite-intro"; profile: Profile };

/* -------------------------------- constants ------------------------------- */

const STORAGE_KEY = "chsyp-local-v1";
const DRAFTS_KEY = "chsyp-drafts-v1";
const READ_KEY = "chsyp-read-v1";
const THEME_KEY = "chsyp-theme-v1";
const LINKS_KEY = "chsyp-links-v1";
const LONG_MSG_KEY = "chsyp-longmsg-v1";
const SHOW_ICONS_KEY = "chsyp-showicons-v1";
const SESSION_KEY = "chsyp-active-account";
const INVITE_PREFIX = "chsyp-invite-";
const TRANSFER_PREFIX = "chsyp-xfer-";
const TRANSFER_CHUNK = 14000;
const MSG_LIMIT_SHORT = 100;
const MSG_LIMIT_LONG = 500;
const MONTH = 30 * 24 * 60 * 60 * 1000;
const DIRECT_LIMIT = 100;
const GROUP_PER_MEMBER = 50;
const OUTBOX_LIMIT = 300;
const GROUP_DELETION_LIMIT = 200;
const MAX_HOPS = 3;
const NAME_RE = /^[A-Za-z0-9_-]{1,15}$/;
const COLORS = ["#F15A3A", "#315CFF", "#7A55D9", "#0C8B74", "#D4860B"];
const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[a-z]{2,}[^\s<>"']*)/gi;
const TRAILING_PUNCTUATION_RE = /[.,!?;:)\]}'"”’]+$/;

const EMOJI_GROUPS: { name: string; icon: string; emojis: string[] }[] = [
  { name: "Smileys", icon: "😀", emojis: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","😋","😛","😜","🤪","😝","🤗","🤭","🤫","🤔","🤐","😐","😑","😶","😏","😒","🙄","😬","😌","😔","😪","😴","😷","🤒","🤕","🥵","🥶","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐","😕","😟","🙁","😮","😯","😲","😳","🥺","😦","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","🤬","😈","💀","🤡","👻","👽","🤖"] },
  { name: "Gestures", icon: "👍", emojis: ["👍","👎","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","👇","☝️","✋","🤚","🖐️","🖖","👋","🤝","🙏","✍️","💪","🦾","🙌","👐","🤲","👏","🫶","🤛","🤜","✊","👊","🫰","🫵","💅","👂","👀","🧠","🫀"] },
  { name: "Hearts", icon: "❤️", emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","♥️","💌","💋","🫂","👼","💐","🌹","🌷","🌸","💫","⭐","🌟","✨","💥","🔥","🎉","🎊","🎁","🎈"] },
  { name: "Animals", icon: "🐶", emojis: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐢","🐍","🐙","🦑","🦀","🐬","🐳","🐟","🦈","🐊","🐘","🦒","🦓","🐄","🐑","🐕","🐈","🕊️","🦕"] },
  { name: "Food", icon: "🍎", emojis: ["🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🍆","🥔","🥕","🌽","🌶️","🥒","🥬","🥦","🧄","🧅","🍄","🥜","🌰","🍞","🥐","🥖","🥯","🧀","🥚","🍳","🥞","🧇","🥓","🍔","🍟","🍕","🌭","🥪","🌮","🌯","🥗","🍝","🍜","🍲","🍣","🍱","🍙","🍚","🍛","🍤","🍦","🍩","🍪","🎂","🍰","🧁","🍫","🍬","🍭","🍯","🍺","🍻","🥂","🍷","🥃","🍸","☕","🍵","🧋","🥤","🧃","🍶"] },
  { name: "Activity", icon: "⚽", emojis: ["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🪀","🏓","🏸","🏒","🏑","🥍","🏏","🥅","⛳","🪁","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🛷","⛸️","🥌","🎿","⛷️","🏂","🏋️","🤸","🤺","🤾","🏌️","🏇","🧘","🏃","🚴","🚵","🎮","🕹️","🎲","🧩","🎯","🎳","🎪","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎸","🎺","🎻","🪕"] },
  { name: "Travel", icon: "✈️", emojis: ["🚗","🚕","🚙","🚌","🚎","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚛","🚜","🦯","🦽","🛵","🏍️","🛺","🚲","🛴","🚨","🚔","🚍","🚞","🚝","🚄","🚅","🚈","🚂","🚆","🚇","🚊","🚉","✈️","🛫","🛬","🛩️","💺","🚁","🚟","🚠","🛰️","🚀","🛸","🛶","⛵","🚤","🛥️","🛳️","⛴️","🚢","⚓","🗺️","🗿","🗽","🗼","🏰","🏯","🎡","🎢","🎠","⛲","⛱️","🏖️","🏝️","🏜️","🌋","⛰️","🏔️","🗻","🏕️","⛺","🏠","🏡","🏢","🏥","🏦","🏨","🏫","🌆","🌇","🌃","🌉","🌌"] },
  { name: "Objects", icon: "💡", emojis: ["⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","💽","💾","💿","📷","📸","📹","🎥","📞","☎️","📟","📠","📺","📻","🧭","⏰","⏲️","⏱️","🕰️","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯️","🧯","🛢️","💸","💵","💴","💶","💷","🪙","💰","💳","💎","⚖️","🪜","🧰","🔧","🔨","⚒️","🛠️","⛏️","🔩","⚙️","🧱","⛓️","🧲","💣","🧨","🔪","🗡️","🛡️","🚬","⚰️","🔮","📿","🧿","💈","⚗️","🔭","🔬","🕳️","💊","💉","🩸","🩹","🩺","🌡️","🧹","🧺","🧻","🚽","🚿","🛁","🧼","🪒","🧴","🔑","🗝️","🚪","🪑","🛋️","🛏️","🧸","🖼️","🛍️","🎀","📦","📫","📮","✏️","✒️","🖋️","🖊️","🖌️","🖍️","📝","📄","📃","📑","📊","📈","📉","📆","📅","📇","🗃️","🗄️","📋","📁","📂","🗂️","🗞️","📰","📓","📔","📒","📕","📗","📘","📙","📚","📖","🔖","🔗","📎","🖇️","📐","📏","🧮","📌","📍","✂️","🔍","🔎","🔐","🔒","🔓"] },
  { name: "Symbols", icon: "✅", emojis: ["✅","❌","❎","✔️","☑️","🔘","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔺","🔻","🔸","🔹","🔶","🔷","🔳","🔲","▪️","▫️","◼️","◻️","⬛","⬜","🟥","🟧","🟨","🟩","🟦","🟪","⭕","🛑","⛔","🚫","💯","💢","💬","👁️‍🗨️","🗨️","🗯️","💭","💤","♻️","⚠️","🚸","☢️","☣️","⬆️","↗️","➡️","↘️","⬇️","↙️","⬅️","↖️","↕️","↔️","↩️","↪️","🔃","🔄","🔙","🔚","🔛","🔜","🔝","🎵","🎶","➕","➖","➗","✖️","♾️","‼️","⁉️","❓","❔","❕","❗","〰️","🔞","🔅","🔆","🆗","🆕","🆒","🆓","🆙","🔤","🔡","🔠","🈁","🚻","🚹","🚺","🚼","🅿️","♿","🈳","🈵","🕐","🕑","🕒","🕓"] },
];

const QUICK_STICKERS = ["👍", "❤️", "😂", "🎉", "👋", "✨", "🤝", "😮", "🔥", "✅"];

/* -------------------------- safe storage wrappers ------------------------- */

function safeStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
function safeStorageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
function safeSessionGet(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function safeSessionSet(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch { /* ignore */ }
}
function safeSessionRemove(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

/* -------------------------------- utilities ------------------------------- */

const emptyData = (): LocalData => ({
  version: 1,
  accounts: [],
  friends: {},
  messages: {},
  groups: {},
  receipts: {},
  presence: {},
  groupDeletions: {},
  outbox: [],
  tombstones: [],
});

function uid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeProfile(nickname: string, bio: string, avatarImage?: string | null): Profile {
  const id = uid();
  const colorIndex = nickname.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return {
    id,
    peerId: `chsyp-user-${id}`,
    nickname,
    bio,
    color: COLORS[colorIndex % COLORS.length],
    createdAt: Date.now(),
    avatarImage: avatarImage || undefined,
  };
}

function threadLimit(isGroup: boolean, memberCount: number) {
  return isGroup ? Math.max(GROUP_PER_MEMBER, memberCount * GROUP_PER_MEMBER) : DIRECT_LIMIT;
}

function pruneThread(messages: ChatMessage[], limit: number) {
  const cutoff = Date.now() - MONTH;
  return messages
    .filter((message) => message.sentAt >= cutoff)
    .sort((a, b) => a.sentAt - b.sentAt)
    .slice(-limit);
}

function pruneOwnerThreads(draft: LocalData, ownerId: string) {
  const threads = draft.messages[ownerId];
  if (!threads) return;
  const ownerGroups = draft.groups[ownerId] ?? [];
  Object.keys(threads).forEach((chatId) => {
    const group = ownerGroups.find((item) => item.id === chatId);
    threads[chatId] = pruneThread(threads[chatId] ?? [], threadLimit(!!group, group?.members.length ?? 0));
  });
}

function pruneEverything(draft: LocalData) {
  Object.keys(draft.messages).forEach((ownerId) => pruneOwnerThreads(draft, ownerId));
  const cutoff = Date.now() - MONTH;
  Object.keys(draft.groupDeletions ?? {}).forEach((ownerId) => {
    draft.groupDeletions[ownerId] = (draft.groupDeletions[ownerId] ?? [])
      .filter((job) => job.createdAt >= cutoff && job.pendingFor.length > 0);
  });
}

function normalizeData(input: unknown): LocalData {
  const parsed = input as Partial<LocalData> | null;
  if (!parsed || !Array.isArray(parsed.accounts)) return emptyData();
  const next: LocalData = {
    ...emptyData(),
    ...parsed,
    version: 1,
    accounts: parsed.accounts,
    friends: parsed.friends ?? {},
    messages: parsed.messages ?? {},
    groups: parsed.groups ?? {},
    receipts: parsed.receipts ?? {},
    presence: parsed.presence ?? {},
    groupDeletions: parsed.groupDeletions ?? {},
    outbox: (parsed.outbox ?? []).slice(-OUTBOX_LIMIT),
    tombstones: parsed.tombstones ?? [],
  };
  pruneEverything(next);
  return next;
}

function loadData(): LocalData {
  try {
    return normalizeData(JSON.parse(safeStorageGet(STORAGE_KEY) || "null"));
  } catch {
    return emptyData();
  }
}

function loadDrafts(): Drafts {
  try {
    return JSON.parse(safeStorageGet(DRAFTS_KEY) || "{}") as Drafts;
  } catch {
    return {};
  }
}

function loadRead(): ReadState {
  try {
    return JSON.parse(safeStorageGet(READ_KEY) || "{}") as ReadState;
  } catch {
    return {};
  }
}

function loadTheme(): Theme {
  const stored = safeStorageGet(THEME_KEY);
  return stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
}

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function loadLinksEnabled(): boolean {
  const stored = safeStorageGet(LINKS_KEY);
  return stored === null ? true : stored === "1";
}

function loadLongMessages(): boolean {
  return safeStorageGet(LONG_MSG_KEY) === "1";
}

function loadShowFriendIcons(): boolean {
  const stored = safeStorageGet(SHOW_ICONS_KEY);
  return stored === null ? true : stored === "1";
}

function makeCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const values = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

type TextPart = { kind: "text"; value: string } | { kind: "link"; href: string; label: string };

function linkifyText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let lastIndex = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text))) {
    let raw = match[0];
    let end = match.index + raw.length;
    const trimmed = raw.match(TRAILING_PUNCTUATION_RE);
    if (trimmed) {
      raw = raw.slice(0, raw.length - trimmed[0].length);
      end -= trimmed[0].length;
    }
    if (!raw) continue;
    if (match.index > lastIndex) parts.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    parts.push({ kind: "link", href, label: raw });
    lastIndex = end;
  }
  if (lastIndex < text.length) parts.push({ kind: "text", value: text.slice(lastIndex) });
  return parts.length ? parts : [{ kind: "text", value: text }];
}

function copyText(text: string): Promise<boolean> {
  try {
    const result = navigator.clipboard?.writeText(text);
    if (result && typeof result.then === "function") return result.then(() => true).catch(() => false);
  } catch {
    /* fallback */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function formatListTime(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(timestamp);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

function formatDateDivider(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(timestamp);
}

function formatLastSeen(timestamp: number) {
  if (!timestamp) return "never";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(timestamp);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Crops an uploaded image to a 1:1 square on HTML5 canvas and reduces quality/dimension
 * iteratively until strictly within the 20 KB (20,480 bytes) limit.
 */
function processAvatarFile(file: File): Promise<{ dataUrl: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const type = (file.type || "").toLowerCase();
    if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(type)) {
      reject(new Error("Please upload a JPEG or PNG image."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to decode image."));
      img.onload = () => {
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas context is unavailable in this browser."));
          return;
        }

        const MAX_BYTES = 20 * 1024; // 20 KB = 20,480 bytes
        let size = Math.min(160, minDim);
        let quality = 0.88;

        const render = (s: number, q: number) => {
          canvas.width = s;
          canvas.height = s;
          ctx.clearRect(0, 0, s, s);
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, s, s);
          return canvas.toDataURL("image/jpeg", q);
        };

        let result = render(size, quality);
        let approxBytes = Math.round((result.length - 22) * 0.75);

        while (approxBytes > MAX_BYTES && quality > 0.25) {
          quality -= 0.08;
          result = render(size, quality);
          approxBytes = Math.round((result.length - 22) * 0.75);
        }

        while (approxBytes > MAX_BYTES && size > 48) {
          size -= 16;
          quality = 0.7;
          result = render(size, quality);
          approxBytes = Math.round((result.length - 22) * 0.75);
        }

        resolve({ dataUrl: result, bytes: approxBytes });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------- primitives ------------------------------- */

function MessageText({ text, linksEnabled }: { text: string; linksEnabled: boolean }) {
  if (!linksEnabled) return <span>{text}</span>;
  const parts = linkifyText(text);
  if (parts.length === 1 && parts[0].kind === "text") return <span>{text}</span>;
  return (
    <span>
      {parts.map((part, index) =>
        part.kind === "link" ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            referrerPolicy="no-referrer"
            className="message-link"
            title={`Opens in a new tab: ${part.href}`}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {part.label}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        )
      )}
    </span>
  );
}

function Avatar({
  profile,
  customImage,
  size = "md",
  preventSave = false,
}: {
  profile: Pick<Profile, "nickname" | "color">;
  customImage?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  preventSave?: boolean;
}) {
  if (customImage) {
    return (
      <div
        className={`avatar avatar-${size} avatar-img`}
        style={{
          backgroundImage: `url(${customImage})`,
          backgroundColor: profile.color,
        }}
        aria-label={`${profile.nickname} icon`}
        onContextMenu={preventSave ? (e) => e.preventDefault() : undefined}
        draggable={false}
      />
    );
  }
  return (
    <div
      className={`avatar avatar-${size}`}
      style={{ backgroundColor: profile.color }}
      aria-label={`${profile.nickname} icon`}
    >
      {profile.nickname.charAt(0) || "?"}
    </div>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand-lockup" aria-label="Chasy P">
      <span className="brand-mark"><MessageCircle size={compact ? 17 : 20} strokeWidth={2.5} /></span>
      <span className={compact ? "brand-name compact" : "brand-name"}>Chasy P</span>
    </div>
  );
}

function Modal({
  children,
  onClose,
  className = "",
  labelledBy,
}: {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
  labelledBy?: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`modal-panel ${className}`}
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 360, damping: 30 }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function ModalHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <div className="modal-header">
      <div>
        <h2 id="modal-title">{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
    </div>
  );
}

function ProfileFields({
  nickname,
  bio,
  onNickname,
  onBio,
  existingNames = [],
}: {
  nickname: string;
  bio: string;
  onNickname: (value: string) => void;
  onBio: (value: string) => void;
  existingNames?: string[];
}) {
  const normalizedNames = existingNames.map((name) => name.toLowerCase());
  const invalidName = nickname.length > 0 && !NAME_RE.test(nickname);
  const duplicate = normalizedNames.includes(nickname.toLowerCase());
  return (
    <div className="form-stack">
      <label className="field-label" htmlFor="nickname">Nickname</label>
      <div className={`field-shell ${invalidName || duplicate ? "invalid" : ""}`}>
        <input
          id="nickname"
          value={nickname}
          onChange={(event) => onNickname(event.target.value.slice(0, 15))}
          placeholder="e.g. north_star"
          autoComplete="off"
          spellCheck={false}
        />
        <span>{nickname.length}/15</span>
      </div>
      <p className="field-hint">
        {duplicate ? "That name is already used on this device." : "Letters, numbers, hyphen, and underscore only."}
      </p>

      <label className="field-label" htmlFor="bio">Profile</label>
      <div className="field-shell textarea-shell">
        <textarea
          id="bio"
          value={bio}
          onChange={(event) => onBio(event.target.value.slice(0, 100))}
          placeholder="A short introduction for new friends"
          rows={4}
        />
        <span>{bio.length}/100</span>
      </div>
    </div>
  );
}

/* ------------------------------- onboarding ------------------------------- */

function Onboarding({ onCreate, theme, onTheme, onTransfer }: { onCreate: (profile: Profile) => void; theme: Theme; onTheme: (theme: Theme) => void; onTransfer: () => void }) {
  const [step, setStep] = useState<"landing" | "profile" | "safety">("landing");
  const [nickname, setNickname] = useState("");
  const [bio, setBio] = useState("");
  const [age, setAge] = useState(false);
  const [risk, setRisk] = useState(false);
  const [availability, setAvailability] = useState(false);

  const profileValid = NAME_RE.test(nickname) && bio.length <= 100;
  const restart = () => {
    setStep("landing");
    setAge(false);
    setRisk(false);
    setAvailability(false);
  };

  return (
    <main className="onboarding-shell">
      <div className="onboarding-grid" aria-hidden="true" />
      <header className="onboarding-header">
        <BrandMark />
        <ThemeSwitch theme={theme} onTheme={onTheme} compact />
      </header>
      <AnimatePresence mode="wait">
        {step === "landing" && (
          <motion.section key="landing" className="landing-composition" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -12 }}>
            <div className="landing-copy">
              <p className="overline"><Radio size={14} /> Whispers between browsers</p>
              <h1>Chasy P</h1>
              <p className="landing-headline">A separate connection between you and your friends.</p>
              <p className="landing-support">Logs are not aggregated or stored on a central server. Data is retained by you and exchanged directly between devices.</p>
              <div className="landing-features">
                <div><span><LockKeyhole size={14} /></span><p><strong>No central history</strong> Messages live only on your devices</p></div>
                <div><span><Radio size={14} /></span><p><strong>Relayed groups</strong> Members reach each other through mutual friends</p></div>
                <div><span><Database size={14} /></span><p><strong>Your data, your backup</strong> Export everything as JSON</p></div>
              </div>
              <div className="landing-actions">
                <button className="primary-button landing-cta" onClick={() => setStep("profile")}>Set up Chasy P <ArrowLeft className="arrow-forward" size={18} /></button>
                <button className="secondary-button landing-cta" onClick={onTransfer}><SmartphoneNfc size={16} /> Move from another device</button>
              </div>
            </div>
            <div className="signal-visual" aria-label="Illustration of two peers connecting">
              <motion.div className="signal-orbit orbit-one" animate={{ rotate: 360 }} transition={{ duration: 24, repeat: Infinity, ease: "linear" }} />
              <motion.div className="signal-orbit orbit-two" animate={{ rotate: -360 }} transition={{ duration: 18, repeat: Infinity, ease: "linear" }} />
              <motion.div className="peer-node node-a" animate={{ y: [0, -10, 0] }} transition={{ duration: 4, repeat: Infinity }}><span>A</span></motion.div>
              <motion.div className="peer-node node-b" animate={{ y: [0, 10, 0] }} transition={{ duration: 4, repeat: Infinity, delay: 0.5 }}><span>B</span></motion.div>
              <motion.div className="signal-line" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.5, duration: 1 }} />
              <div className="visual-caption"><LockKeyhole size={15} /> Encrypted WebRTC data channel</div>
            </div>
          </motion.section>
        )}

        {step === "profile" && (
          <motion.section key="profile" className="setup-stage" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
            <button className="text-button back-button" onClick={() => setStep("landing")}><ArrowLeft size={16} /> Back</button>
            <div className="step-indicator"><span className="active" /> <span /></div>
            <p className="overline">Your local identity</p>
            <h1>How should friends see you?</h1>
            <p className="setup-support">Your icon is made from the first letter of your nickname. You can also upload a custom 1:1 image icon anytime.</p>
            <div className="profile-preview">
              <Avatar profile={{ nickname: nickname || "?", color: COLORS[(nickname.charCodeAt(0) || 0) % COLORS.length] }} size="lg" />
              <div><strong>{nickname || "Your nickname"}</strong><span>{bio || "Your profile will appear here."}</span></div>
            </div>
            <ProfileFields nickname={nickname} bio={bio} onNickname={setNickname} onBio={setBio} />
            <div className="setup-actions">
              <button className="primary-button wide" disabled={!profileValid} onClick={() => setStep("safety")}>Continue</button>
            </div>
          </motion.section>
        )}

        {step === "safety" && (
          <motion.section key="safety" className="setup-stage" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
            <button className="text-button back-button" onClick={() => setStep("profile")}><ArrowLeft size={16} /> Back</button>
            <div className="step-indicator"><span className="active" /> <span className="active" /></div>
            <p className="overline warning"><Shield size={14} /> Before you enter</p>
            <h1>Private means unmonitored.</h1>
            <p className="setup-support">Chasy P is a direct communication tool. Please read and accept every point to continue.</p>
            <div className="consent-list">
              <label className={age ? "consent-row checked" : "consent-row"}>
                <input type="checkbox" checked={age} onChange={(event) => setAge(event.target.checked)} />
                <span className="custom-check">{age && <Check size={15} />}</span>
                <span><strong>Are you 13 or older?</strong><small>This service is not intended for children under 13.</small></span>
              </label>
              <label className={risk ? "consent-row checked" : "consent-row"}>
                <input type="checkbox" checked={risk} onChange={(event) => setRisk(event.target.checked)} />
                <span className="custom-check">{risk && <Check size={15} />}</span>
                <span><strong>You understand the responsibility.</strong><small>The developer cannot monitor conversation content and assumes no responsibility whatsoever.</small></span>
              </label>
              <label className={availability ? "consent-row checked" : "consent-row"}>
                <input type="checkbox" checked={availability} onChange={(event) => setAvailability(event.target.checked)} />
                <span className="custom-check">{availability && <Check size={15} />}</span>
                <span><strong>The service may be suspended without prior notice.</strong><small>Chasy P is provided as-is, with no guarantee of availability, and may be changed, interrupted, or discontinued at any time without prior notice.</small></span>
              </label>
            </div>
            <div className="setup-actions two-up consent-actions">
              <button className="secondary-button" onClick={restart}>Disagree</button>
              <button className="primary-button" disabled={!age || !risk || !availability} onClick={() => onCreate(makeProfile(nickname, bio))}>Agree and enter</button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
      <footer className="onboarding-footer">Local-first · WebRTC · No application database · Inside iframe</footer>
    </main>
  );
}

/* --------------------------------- dialogs -------------------------------- */

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span className="toggle-icon">{icon}</span>
      <span className="toggle-copy"><strong>{title}</strong><small>{description}</small></span>
      <span className={checked ? "toggle-switch on" : "toggle-switch"} role="switch" aria-checked={checked}>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="toggle-knob" />
      </span>
    </label>
  );
}

function ThemeSwitch({ theme, onTheme, compact = false }: { theme: Theme; onTheme: (theme: Theme) => void; compact?: boolean }) {
  const options: { value: Theme; icon: React.ReactNode; label: string }[] = [
    { value: "light", icon: <Sun size={14} />, label: "Standard" },
    { value: "dark", icon: <Moon size={14} />, label: "Dark" },
    { value: "system", icon: <Monitor size={14} />, label: "Auto" },
  ];
  return (
    <div className={compact ? "theme-switch compact" : "theme-switch"} role="group" aria-label="Colour theme">
      {options.map((option) => (
        <button
          key={option.value}
          className={theme === option.value ? "active" : ""}
          onClick={() => onTheme(option.value)}
          title={option.label}
          aria-pressed={theme === option.value}
        >
          {option.icon}{!compact && <span>{option.label}</span>}
        </button>
      ))}
    </div>
  );
}

function AddFriendDialog({
  onClose,
  inviteCode,
  inviteStatus,
  onGenerate,
  onJoin,
  onCopy,
}: {
  onClose: () => void;
  inviteCode: string;
  inviteStatus: string;
  onGenerate: () => void;
  onJoin: (code: string) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const [mode, setMode] = useState<"share" | "join">("share");
  const [code, setCode] = useState("");
  useEffect(() => {
    if (mode === "share" && !inviteCode) onGenerate();
  }, [mode, inviteCode, onGenerate]);
  const shareText = inviteCode ? `Join me on Chasy P — my connection code is ${inviteCode}. Open Chasy P, add a friend, and enter the code while I keep my window open.` : "";
  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader title="Add a friend" subtitle="One code, then Chasy P remembers the connection." onClose={onClose} />
      <div className="segmented-control">
        <button className={mode === "share" ? "active" : ""} onClick={() => setMode("share")}>Share a code</button>
        <button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>Enter a code</button>
      </div>
      {mode === "share" ? (
        <div className="invite-content">
          <p className="small-label">Temporary connection number</p>
          <div className="invite-code">
            {inviteCode || "------"}
            <button className="icon-button" disabled={!inviteCode} onClick={() => onCopy(inviteCode, "Code copied")} aria-label="Copy code"><Copy size={18} /></button>
          </div>
          <p className="invite-status"><span className={inviteCode ? "pulse-dot" : ""} />{inviteStatus || "Opening a temporary WebRTC rendezvous..."}</p>
          {inviteCode && (
            <div className="share-actions">
              <button className="secondary-button small" onClick={() => onCopy(shareText, "Invitation copied")}><Copy size={14} /> Copy share message</button>
            </div>
          )}
        </div>
      ) : (
        <form className="invite-content" onSubmit={(event) => { event.preventDefault(); onJoin(code); }}>
          <label className="small-label" htmlFor="invite-code">Friend's 6-character number</label>
          <input
            id="invite-code"
            className="code-input"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
            placeholder="A7K2Q9"
            autoFocus
          />
          <button className="primary-button wide" disabled={code.length !== 6}>Connect securely</button>
          {inviteStatus && <p className="invite-status centered">{inviteStatus}</p>}
        </form>
      )}
      <div className="technical-note"><Info size={16} /><p>The number is used only for WebRTC signaling. Peer discovery uses the public PeerJS broker; messages and profiles are not stored there.</p></div>
    </Modal>
  );
}

function CreateAccountDialog({ accounts, onClose, onCreate }: { accounts: Profile[]; onClose: () => void; onCreate: (profile: Profile) => void }) {
  const [nickname, setNickname] = useState("");
  const [bio, setBio] = useState("");
  const [accepted, setAccepted] = useState(false);
  const unique = !accounts.some((account) => account.nickname.toLowerCase() === nickname.toLowerCase());
  const valid = NAME_RE.test(nickname) && unique && bio.length <= 100 && accepted;
  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader title="Create another identity" subtitle={`${accounts.length}/5 identities are stored on this device.`} onClose={onClose} />
      <ProfileFields nickname={nickname} bio={bio} onNickname={setNickname} onBio={setBio} existingNames={accounts.map((account) => account.nickname)} />
      <label className="mini-consent"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> <span>I accept the same age, safety, and availability terms for this identity — including that the service may be suspended without prior notice.</span></label>
      <button className="primary-button wide" disabled={!valid} onClick={() => onCreate(makeProfile(nickname, bio))}>Create identity</button>
    </Modal>
  );
}

function EditProfileDialog({
  account,
  accounts,
  onClose,
  onSave,
}: {
  account: Profile;
  accounts: Profile[];
  onClose: () => void;
  onSave: (nickname: string, bio: string, avatarImage: string | null) => void;
}) {
  const [nickname, setNickname] = useState(account.nickname);
  const [bio, setBio] = useState(account.bio);
  const [avatarImage, setAvatarImage] = useState<string | null>(account.avatarImage ?? null);
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; bytes: number } | null>(null);
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [imageError, setImageError] = useState("");
  const [processing, setProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const otherNames = accounts.filter((item) => item.id !== account.id).map((item) => item.nickname);
  const unique = !otherNames.some((name) => name.toLowerCase() === nickname.toLowerCase());
  const valid = NAME_RE.test(nickname) && unique && bio.length <= 100;

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageError("");
    setProcessing(true);
    try {
      const result = await processAvatarFile(file);
      setPendingImage(result);
      setConsentAgreed(false);
    } catch (err: unknown) {
      setImageError(err instanceof Error ? err.message : "Failed to process image.");
    } finally {
      setProcessing(false);
      event.target.value = "";
    }
  };

  const applyPendingImage = () => {
    if (!pendingImage || !consentAgreed) return;
    setAvatarImage(pendingImage.dataUrl);
    setPendingImage(null);
    setConsentAgreed(false);
  };

  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader title="Edit your profile" subtitle="Friends receive changes the next time you are both online." onClose={onClose} />
      
      <div className="avatar-edit-card">
        <div className="avatar-preview-row">
          <Avatar
            profile={{ nickname: nickname || "?", color: account.color }}
            customImage={pendingImage ? pendingImage.dataUrl : avatarImage}
            size="lg"
          />
          <div className="avatar-preview-text">
            <strong>Profile Icon</strong>
            <small>
              {pendingImage
                ? `1:1 preview (${formatBytes(pendingImage.bytes)}, max 20 KB)`
                : avatarImage
                  ? "Custom circular icon active (shared only while online)"
                  : "First letter of your nickname is used as default icon"}
            </small>
          </div>
        </div>

        {pendingImage ? (
          <div className="avatar-consent-box">
            <label className="avatar-consent-check">
              <input
                type="checkbox"
                checked={consentAgreed}
                onChange={(e) => setConsentAgreed(e.target.checked)}
              />
              <span>
                <strong>Image Icon Agreement:</strong> I agree not to use images that may offend others, depict inappropriate content, or violate the rights of others. Only users who agree may set a profile icon.
              </span>
            </label>
            <div className="avatar-edit-actions">
              <button
                type="button"
                className="primary-button small"
                disabled={!consentAgreed}
                onClick={applyPendingImage}
              >
                Apply icon
              </button>
              <button
                type="button"
                className="secondary-button small"
                onClick={() => { setPendingImage(null); setConsentAgreed(false); }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="avatar-edit-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={handleFile}
            />
            <button
              type="button"
              className="secondary-button small"
              disabled={processing}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon size={14} /> {avatarImage ? "Change image icon" : "Upload image icon"}
            </button>
            {avatarImage && (
              <button
                type="button"
                className="secondary-button small danger-text"
                onClick={() => setAvatarImage(null)}
              >
                <Trash2 size={14} /> Remove icon (use text)
              </button>
            )}
          </div>
        )}
        {imageError && <p className="field-hint danger-text">{imageError}</p>}
      </div>

      <ProfileFields nickname={nickname} bio={bio} onNickname={setNickname} onBio={setBio} existingNames={otherNames} />
      <button
        className="primary-button wide"
        disabled={!valid || pendingImage !== null}
        onClick={() => onSave(nickname, bio, avatarImage)}
      >
        Save profile
      </button>
    </Modal>
  );
}

function GroupDialog({ active, friends, onClose, onCreate }: { active: Profile; friends: Friend[]; onClose: () => void; onCreate: (name: string, ids: string[]) => void }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const eligible = friends.filter((friend) => friend.relation === "active");
  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader title="Start a group" subtitle="Choose people who are already your friends." onClose={onClose} />
      <label className="field-label" htmlFor="group-name">Group name</label>
      <div className="field-shell"><input id="group-name" value={name} onChange={(event) => setName(event.target.value.slice(0, 30))} placeholder="Weekend plans" /><span>{name.length}/30</span></div>
      <p className="small-label member-label">Members</p>
      <div className="member-picker">
        {eligible.length === 0 && <p className="empty-picker">Add friends before creating a group.</p>}
        {eligible.map((friend) => {
          const checked = selected.includes(friend.id);
          return (
            <button key={friend.id} className={checked ? "member-row selected" : "member-row"} onClick={() => setSelected((current) => checked ? current.filter((id) => id !== friend.id) : [...current, friend.id])}>
              <Avatar profile={friend} size="sm" /><span>{friend.nickname}</span><span className="member-check">{checked && <Check size={15} />}</span>
            </button>
          );
        })}
      </div>
      <button className="primary-button wide" disabled={!name.trim() || selected.length < 2} onClick={() => onCreate(name.trim(), selected)}>Create with {selected.length + 1} members</button>
      <p className="dialog-footnote">{active.nickname} will be the creator. Members do not all have to be friends with each other — Chasy P relays their messages through anyone who can reach them. History keeps members × {GROUP_PER_MEMBER} messages.</p>
    </Modal>
  );
}

function EmojiPicker({
  onInsert,
  onSendSticker,
  onClose,
}: {
  onInsert: (emoji: string) => void;
  onSendSticker: (emoji: string) => void;
  onClose: () => void;
}) {
  const [category, setCategory] = useState(0);
  const [asSticker, setAsSticker] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if ((target as HTMLElement)?.closest?.(".composer-icon")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <motion.div
      ref={panelRef}
      className="emoji-picker"
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
    >
      <div className="emoji-head">
        <strong>Emoji</strong>
        <label className="sticker-toggle">
          <input type="checkbox" checked={asSticker} onChange={(event) => setAsSticker(event.target.checked)} />
          <span>Send as sticker</span>
        </label>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close emoji picker"><X size={16} /></button>
      </div>
      <div className="quick-stickers">
        {QUICK_STICKERS.map((sticker) => (
          <button type="button" key={sticker} onClick={() => onSendSticker(sticker)} title="Send immediately">{sticker}</button>
        ))}
      </div>
      <div className="emoji-tabs">
        {EMOJI_GROUPS.map((group, index) => (
          <button type="button" key={group.name} className={index === category ? "active" : ""} onClick={() => setCategory(index)} title={group.name}>
            {group.icon}
          </button>
        ))}
      </div>
      <div className="emoji-grid">
        {EMOJI_GROUPS[category].emojis.map((emoji) => (
          <button type="button" key={emoji} onClick={() => (asSticker ? onSendSticker(emoji) : onInsert(emoji))}>{emoji}</button>
        ))}
      </div>
    </motion.div>
  );
}

function TransferDialog({
  mode,
  snapshot,
  onClose,
  onReceive,
  onCopy,
  onEraseAfterSend,
}: {
  mode: "send" | "receive";
  snapshot: () => TransferPayload;
  onClose: () => void;
  onReceive: (payload: TransferPayload) => boolean;
  onCopy: (text: string, label: string) => void;
  onEraseAfterSend: () => void;
}) {
  const [code, setCode] = useState("");
  const [entry, setEntry] = useState("");
  const [phase, setPhase] = useState<"idle" | "waiting" | "busy" | "done" | "error">(mode === "send" ? "waiting" : "idle");
  const [status, setStatus] = useState(mode === "send" ? "Opening a private channel…" : "");
  const [progress, setProgress] = useState(0);
  const peerRef = useRef<Peer | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const cleanup = useCallback(() => {
    try { peerRef.current?.destroy(); } catch { /* ignore */ }
    peerRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  useEffect(() => {
    if (mode !== "send") return;
    let cancelled = false;

    const open = (attempt: number) => {
      if (cancelled || attempt > 4) return;
      const next = makeCode();
      setCode(next);
      const peer = new Peer(`${TRANSFER_PREFIX}${next}`, { debug: 0 });
      peerRef.current = peer;

      peer.on("open", () => {
        if (cancelled) return;
        setPhase("waiting");
        setStatus("Ready. Enter this code on the new device.");
      });

      peer.on("connection", (conn) => {
        conn.on("data", (raw) => {
          if (cancelled) return;
          const wire = raw as TransferWire;

          if (wire?.t === "ack") {
            setPhase("done");
            setStatus("Transfer complete.");
            return;
          }
          if (wire?.t !== "hello") return;

          setPhase("busy");
          setStatus("New device found — sending your data…");
          let text: string;
          try {
            text = JSON.stringify(snapshotRef.current());
          } catch {
            setPhase("error");
            setStatus("Could not read local data.");
            return;
          }
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += TRANSFER_CHUNK) chunks.push(text.slice(i, i + TRANSFER_CHUNK));
          conn.send({ t: "begin", total: chunks.length } satisfies TransferWire);
          chunks.forEach((s, i) => conn.send({ t: "chunk", i, s } satisfies TransferWire));
          conn.send({ t: "end" } satisfies TransferWire);
          setProgress(100);
        });
      });

      peer.on("error", (error) => {
        if (cancelled) return;
        if (error.type === "unavailable-id") {
          peer.destroy();
          open(attempt + 1);
        } else {
          setPhase("error");
          setStatus("Could not open the channel. Check your connection.");
        }
      });
    };

    open(0);
    return () => { cancelled = true; };
  }, [mode]);

  const startReceive = () => {
    if (entry.length !== 6) return;
    cleanup();
    setPhase("busy");
    setProgress(0);
    setStatus("Looking for the other device…");
    const peer = new Peer("", { debug: 0 });
    peerRef.current = peer;
    let expected = 0;
    const parts: string[] = [];

    peer.on("open", () => {
      const conn = peer.connect(`${TRANSFER_PREFIX}${entry}`, { reliable: true, metadata: { kind: "transfer" } });
      const timeout = window.setTimeout(() => {
        if (!conn.open) {
          setPhase("error");
          setStatus("No device is offering that code right now.");
          conn.close();
        }
      }, 12000);

      conn.on("open", () => {
        window.clearTimeout(timeout);
        setStatus("Connected — receiving…");
        conn.send({ t: "hello" } satisfies TransferWire);
      });

      conn.on("data", (raw) => {
        const wire = raw as TransferWire;
        if (wire?.t === "begin") {
          expected = wire.total;
          parts.length = 0;
          return;
        }
        if (wire?.t === "chunk") {
          parts[wire.i] = wire.s;
          if (expected) setProgress(Math.round((parts.filter(Boolean).length / expected) * 100));
          return;
        }
        if (wire?.t !== "end") return;
        const filled = parts.filter((part) => typeof part === "string").length;
        if (!expected || filled !== expected) {
          setPhase("error");
          setStatus("The transfer arrived incomplete. Please try again.");
          return;
        }
        try {
          const payload = JSON.parse(parts.join("")) as TransferPayload;
          if (payload?.kind !== "chsyp-transfer") throw new Error("shape");
          if (!onReceive(payload)) throw new Error("empty");
          conn.send({ t: "ack" } satisfies TransferWire);
          setPhase("done");
          setStatus("Your data is now on this device.");
        } catch {
          setPhase("error");
          setStatus("That data could not be read.");
        }
      });

      conn.on("error", () => {
        setPhase("error");
        setStatus("The connection failed. Check the code and try again.");
      });
    });

    peer.on("error", () => {
      setPhase("error");
      setStatus("Could not reach the signalling service.");
    });
  };

  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader
        title={mode === "send" ? "Move to a new device" : "Bring data from another device"}
        subtitle={mode === "send"
          ? "Streams every identity, friend, and message straight to your other device."
          : "Enter the code shown on your old device."}
        onClose={onClose}
      />

      {mode === "send" ? (
        <div className="invite-content">
          <p className="small-label">Transfer code</p>
          <div className="invite-code">
            {code || "------"}
            <button className="icon-button" disabled={!code} onClick={() => onCopy(code, "Code copied")} aria-label="Copy code"><Copy size={18} /></button>
          </div>
          <p className="invite-status">
            <span className={phase === "waiting" ? "pulse-dot" : ""} />{status}
          </p>
          {phase === "busy" && <div className="xfer-bar"><span style={{ width: `${progress}%` }} /></div>}
          {phase === "done" && (
            <div className="xfer-done">
              <CheckCircle2 size={16} />
              <p>Everything was copied. Two devices cannot use the same identities at once — erase this one, or keep it closed from now on.</p>
              <button className="danger-button small" onClick={onEraseAfterSend}><Eraser size={14} /> Erase this device</button>
            </div>
          )}
        </div>
      ) : (
        <form className="invite-content" onSubmit={(event) => { event.preventDefault(); startReceive(); }}>
          <label className="small-label" htmlFor="xfer-code">6-character code</label>
          <input
            id="xfer-code"
            className="code-input"
            value={entry}
            onChange={(event) => setEntry(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
            placeholder="A7K2Q9"
            autoFocus
            disabled={phase === "busy" || phase === "done"}
          />
          {phase !== "done" && (
            <button className="primary-button wide" disabled={entry.length !== 6 || phase === "busy"}>
              {phase === "busy" ? "Receiving…" : "Receive data"}
            </button>
          )}
          {phase === "busy" && progress > 0 && <div className="xfer-bar"><span style={{ width: `${progress}%` }} /></div>}
          {status && <p className={phase === "error" ? "invite-status centered danger-text" : "invite-status centered"}>{status}</p>}
          {phase === "done" && <button type="button" className="primary-button wide" onClick={onClose}>Start using Chasy P</button>}
        </form>
      )}

      <div className="technical-note">
        <Info size={16} />
        <p>The code only exists while this window is open and is used purely to pair the two devices. Your data travels directly between them over an encrypted WebRTC channel — it is never uploaded. Keep both devices on the same page until it finishes.</p>
      </div>
    </Modal>
  );
}

function SettingsDialog({
  theme,
  onTheme,
  linksEnabled,
  onLinksEnabled,
  showFriendIcons,
  onShowFriendIcons,
  longMessages,
  onLongMessages,
  storageBytes,
  pendingOutbox,
  pendingGroupNotices,
  pendingNotices,
  deliveredNotices,
  noticeState,
  friendCount,
  connectedCount,
  networkState,
  onNotifyNow,
  onClose,
  onExport,
  onImport,
  onTransfer,
  onEraseDevice,
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  linksEnabled: boolean;
  onLinksEnabled: (value: boolean) => void;
  showFriendIcons: boolean;
  onShowFriendIcons: (value: boolean) => void;
  longMessages: boolean;
  onLongMessages: (value: boolean) => void;
  storageBytes: number;
  pendingOutbox: number;
  pendingGroupNotices: number;
  pendingNotices: number;
  deliveredNotices: number;
  noticeState: "idle" | "online" | "retrying";
  friendCount: number;
  connectedCount: number;
  networkState: string;
  onNotifyNow: () => void;
  onClose: () => void;
  onExport: () => void;
  onImport: () => void;
  onTransfer: () => void;
  onEraseDevice: () => void;
}) {
  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader title="Settings" subtitle="Appearance and local preferences live only on this device." onClose={onClose} />
      <p className="small-label">Appearance</p>
      <ThemeSwitch theme={theme} onTheme={onTheme} />
      <p className="settings-hint">“Auto” follows your operating system setting.</p>

      <p className="small-label section-gap">Messages & Icons</p>
      <div className="form-stack">
        <ToggleRow
          icon={<ImageIcon size={17} />}
          title="Show friends' profile icons"
          description="Display circular icon images shared by online friends. Turn off to always view standard text icons."
          checked={showFriendIcons}
          onChange={onShowFriendIcons}
        />
        <ToggleRow
          icon={<LinkIcon size={17} />}
          title="Clickable links"
          description="Turn website links inside messages into tap-to-open links. Turn off to view links as plain text."
          checked={linksEnabled}
          onChange={onLinksEnabled}
        />
        <ToggleRow
          icon={<Pencil size={17} />}
          title={`Longer messages (${MSG_LIMIT_LONG})`}
          description={`Messages are capped at ${MSG_LIMIT_SHORT} characters by default. Turn on to allow up to ${MSG_LIMIT_LONG} characters.`}
          checked={longMessages}
          onChange={onLongMessages}
        />
      </div>

      <p className="small-label section-gap">Connection</p>
      <div className="diagnostics">
        <div><span className="dot" data-state={networkState} /><strong>{networkState === "online" ? "Signalling online" : networkState}</strong><small>PeerJS broker</small></div>
        <div><Activity size={15} /><strong>{connectedCount} / {friendCount}</strong><small>Friends connected now</small></div>
        <div><Mail size={15} /><strong>{pendingOutbox + pendingGroupNotices}</strong><small>Queued notices waiting</small></div>
      </div>

      {pendingNotices > 0 ? (
        <div className="notice-panel">
          <div className="notice-head">
            <BellRing size={16} />
            <div>
              <strong>{pendingNotices} former friend{pendingNotices === 1 ? "" : "s"} still to notify</strong>
              <small>
                {noticeState === "online"
                  ? "Checking every 20 seconds while this tab is open."
                  : noticeState === "retrying"
                    ? "Reconnecting to the broker…"
                    : "The worker starts as soon as the broker is reachable."}
                {deliveredNotices > 0 ? ` ${deliveredNotices} delivered this session.` : ""}
              </small>
            </div>
          </div>
          <p className="settings-hint">Each identity you deleted leaves a note here. Whenever you open Chasy P, it looks for those people and tells them the account is gone — they drop it from their list, and the note is cleared once they confirm.</p>
          <button className="secondary-button wide" onClick={onNotifyNow}><RefreshCw size={15} /> Notify now</button>
        </div>
      ) : (
        <div className="notice-panel clear">
          <CheckCircle2 size={16} />
          <div><strong>No pending deletion notices</strong><small>Every former contact has been told, or none were waiting.</small></div>
        </div>
      )}

      <p className="small-label section-gap">Local data · {formatBytes(storageBytes)} used</p>
      <div className="action-list">
        <button onClick={onTransfer}><SmartphoneNfc size={18} /><span><strong>Move to a new device</strong><small>Send everything over a private 6-character code.</small></span></button>
        <button onClick={onExport}><Download size={18} /><span><strong>Export backup</strong><small>Download everything as a JSON file.</small></span></button>
        <button onClick={onImport}><FileUp size={18} /><span><strong>Import backup</strong><small>Replace local data with a saved file.</small></span></button>
        <button className="danger-text" onClick={onEraseDevice}><Eraser size={18} /><span><strong>Erase this device</strong><small>Removes every identity, friend, and message stored here.</small></span></button>
      </div>

      <div className="technical-note"><Info size={16} /><p>Retention: direct chats keep {DIRECT_LIMIT} entries, groups keep members × {GROUP_PER_MEMBER}. Anything older than 30 days is removed automatically. Deletion logs count toward these limits. A friend is only removed unilaterally if a deletion request was submitted and they remained offline for 1 month without connecting.</p></div>
    </Modal>
  );
}

function TimedOutDeletionsDialog({
  timedOutFriends,
  seenAt,
  onClose,
  onFinalize,
}: {
  timedOutFriends: Friend[];
  seenAt: (friendId: string, addedAt: number) => number;
  onClose: () => void;
  onFinalize: (friend: Friend) => void;
}) {
  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader
        title="Timed-out removal requests"
        subtitle="You previously requested to delete these friends, and they have not come online even once for over 1 month (30 days). You can now finalize removal without waiting for them."
        onClose={onClose}
      />
      {timedOutFriends.length === 0 ? (
        <p className="modal-copy">No pending removal requests have timed out.</p>
      ) : (
        <div className="stale-list">
          {timedOutFriends.map((friend) => (
            <div key={friend.id}>
              <Avatar profile={friend} size="sm" />
              <span className="stale-body">
                <strong>{friend.nickname}</strong>
                <small><Clock size={11} /> Request sent {formatLastSeen(friend.deleteRequest?.requestedAt || 0)} · last reached {formatLastSeen(seenAt(friend.id, friend.addedAt))}</small>
              </span>
              <button className="danger-button small" onClick={() => onFinalize(friend)}><Trash2 size={14} /> Finalize delete</button>
            </div>
          ))}
        </div>
      )}
      <div className="technical-note"><Info size={16} /><p>Friends who have not had a removal request submitted will stay on your list indefinitely. If a finalized friend logs on later, Chasy P notifies their device so the connection is cleared on their side as well.</p></div>
    </Modal>
  );
}

function GroupInfoDialog({
  group,
  active,
  friends,
  ephemeralAvatars,
  showFriendIcons,
  hasMessages,
  onClose,
  onAdd,
  onDelete,
  onLeave,
  onClearHistory,
  onSelectMessages,
  onExport,
}: {
  group: Group;
  active: Profile;
  friends: Friend[];
  ephemeralAvatars: Record<string, string>;
  showFriendIcons: boolean;
  hasMessages: boolean;
  onClose: () => void;
  onAdd: (ids: string[]) => void;
  onDelete: () => void;
  onLeave: () => void;
  onClearHistory: () => void;
  onSelectMessages: () => void;
  onExport: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const isCreator = group.creatorId === active.id;
  const eligible = friends.filter((friend) => friend.relation === "active" && !group.members.some((member) => member.id === friend.id));
  const directLinks = group.members.filter((member) => member.id !== active.id && friends.some((friend) => friend.id === member.id && friend.relation === "active"));
  return (
    <Modal onClose={onClose} className="medium-modal" labelledBy="modal-title">
      <ModalHeader title={group.name} subtitle={`${group.members.length} members · keeps ${group.members.length * GROUP_PER_MEMBER} messages`} onClose={onClose} />
      {!adding ? (
        <>
          <div className="group-member-list">
            {group.members.map((member) => {
              const direct = member.id === active.id || friends.some((friend) => friend.id === member.id && friend.relation === "active");
              const memberAvatar = member.id === active.id
                ? active.avatarImage
                : showFriendIcons
                  ? ephemeralAvatars[member.id]
                  : undefined;
              return (
                <div key={member.id}>
                  <Avatar profile={member} customImage={memberAvatar} size="sm" preventSave={member.id !== active.id} />
                  <span>
                    <strong>{member.nickname}</strong>
                    <small>{member.id === group.creatorId ? "Creator" : member.id === active.id ? "You" : direct ? (member.bio || "Direct link") : "Reached through other members"}</small>
                  </span>
                  {!direct && member.id !== active.id && <span className="relay-chip" title="Not your friend — messages travel through another member">relayed</span>}
                </div>
              );
            })}
          </div>
          {directLinks.length < group.members.length - 1 && (
            <p className="relay-note"><Radio size={12} /> {group.members.length - 1 - directLinks.length} member{group.members.length - 1 - directLinks.length === 1 ? "" : "s"} are not your friend. Chasy P relays their messages through members you can reach — keep this tab open to help forward theirs.</p>
          )}
          <div className="action-list compact-actions">
            {isCreator && <button disabled={eligible.length === 0} onClick={() => setAdding(true)}><UserPlus size={18} /><span><strong>Add members</strong><small>Only the creator can do this.</small></span></button>}
            <button disabled={!hasMessages} onClick={onSelectMessages}><ListChecks size={18} /><span><strong>Select messages</strong><small>Delete chosen entries from this device.</small></span></button>
            <button disabled={!hasMessages} onClick={onExport}><Download size={18} /><span><strong>Export conversation</strong><small>Save this chat as a text file.</small></span></button>
            <button disabled={!hasMessages} onClick={onClearHistory}><Eraser size={18} /><span><strong>Delete my history</strong><small>Your sent messages become deletion logs for members.</small></span></button>
            <button onClick={onLeave}><DoorOpen size={18} /><span><strong>Leave group</strong><small>{isCreator ? "Creator access transfers to another member." : "You can leave at any time."}</small></span></button>
            {isCreator && <button className="danger-text" onClick={onDelete}><Trash2 size={18} /><span><strong>Delete group</strong><small>Removes the group for everyone.</small></span></button>}
          </div>
        </>
      ) : (
        <>
          <button className="text-button back-button inline-back" onClick={() => setAdding(false)}><ArrowLeft size={16} /> Members</button>
          <div className="member-picker tall-picker">
            {eligible.map((friend) => {
              const checked = selected.includes(friend.id);
              return <button key={friend.id} className={checked ? "member-row selected" : "member-row"} onClick={() => setSelected((current) => checked ? current.filter((id) => id !== friend.id) : [...current, friend.id])}><Avatar profile={friend} size="sm" /><span>{friend.nickname}</span><span className="member-check">{checked && <Check size={15} />}</span></button>;
            })}
          </div>
          <button className="primary-button wide" disabled={!selected.length} onClick={() => { onAdd(selected); setAdding(false); setSelected([]); }}>Add {selected.length || ""} {selected.length === 1 ? "member" : "members"}</button>
        </>
      )}
    </Modal>
  );
}

/* ----------------------------------- app ---------------------------------- */

function App() {
  const [data, setData] = useState<LocalData>(loadData);
  const [drafts, setDrafts] = useState<Drafts>(loadDrafts);
  const [readState, setReadState] = useState<ReadState>(loadRead);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [linksEnabled, setLinksEnabled] = useState<boolean>(loadLinksEnabled);
  const [showFriendIcons, setShowFriendIcons] = useState<boolean>(loadShowFriendIcons);
  const [longMessages, setLongMessages] = useState<boolean>(loadLongMessages);
  const messageLimit = longMessages ? MSG_LIMIT_LONG : MSG_LIMIT_SHORT;

  const firstAccountId = data.accounts[0]?.id ?? "";
  const [activeId, setActiveId] = useState(() => safeSessionGet(SESSION_KEY) || firstAccountId);
  const [selected, setSelected] = useState<string>("");
  const [mobileChat, setMobileChat] = useState(false);
  const [section, setSection] = useState<"friends" | "groups">("friends");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<
    | "add" | "account" | "edit-profile" | "delete-account" | "group" | "group-info"
    | "friend-actions" | "about" | "import" | "settings" | "erase-device"
    | "clear-history" | "purge-request" | "timed-out-deletions"
    | "transfer-send" | "transfer-receive" | null
  >(null);
  const [accountMenu, setAccountMenu] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");
  const [networkState, setNetworkState] = useState<"connecting" | "online" | "offline">("connecting");
  const [onlinePeers, setOnlinePeers] = useState<Set<string>>(new Set());
  const [peerHidden, setPeerHidden] = useState<Record<string, boolean>>({});
  // Ephemeral in-memory avatar store: friendId -> dataUrl. NEVER stored in localStorage or backup!
  const [ephemeralAvatars, setEphemeralAvatars] = useState<Record<string, string>>({});
  const [messageText, setMessageText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [toast, setToast] = useState("");
  const [incomingDelete, setIncomingDelete] = useState<{ friendId: string; requestId: string } | null>(null);
  const [incomingPurge, setIncomingPurge] = useState<{ friendId: string; requestId: string } | null>(null);
  const [importText, setImportText] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [checkedMessages, setCheckedMessages] = useState<string[]>([]);
  const [typing, setTyping] = useState<Record<string, { chatId: string; at: number }>>({});
  const [atBottom, setAtBottom] = useState(true);
  const [notifyTick, setNotifyTick] = useState(0);
  const [noticeState, setNoticeState] = useState<"idle" | "online" | "retrying">("idle");
  const [deliveredNotices, setDeliveredNotices] = useState(0);

  const dataRef = useRef(data);
  const draftsRef = useRef(drafts);
  const activeIdRef = useRef(activeId);
  const peerRef = useRef<Peer | null>(null);
  const invitePeerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<Map<string, DataConnection>>(new Map());
  const packetHandlerRef = useRef<((packet: Packet, conn: DataConnection, ownerId: string) => void) | null>(null);
  const openHandlerRef = useRef<((conn: DataConnection, ownerId: string) => void) | null>(null);
  const connectToRef = useRef<((peerId: string) => DataConnection | null) | null>(null);
  const forceDialRef = useRef<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastTypingSent = useRef(0);

  dataRef.current = data;
  draftsRef.current = drafts;
  activeIdRef.current = activeId;

  const mutate = useCallback((recipe: (draft: LocalData) => void) => {
    setData((current) => {
      const draft = structuredClone(current);
      recipe(draft);
      return draft;
    });
  }, []);

  /* ------------------------------ persistence ----------------------------- */

  useEffect(() => {
    safeStorageSet(STORAGE_KEY, JSON.stringify(data));
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    safeStorageSet(DRAFTS_KEY, JSON.stringify(drafts));
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    safeStorageSet(READ_KEY, JSON.stringify(readState));
  }, [readState]);

  useEffect(() => {
    safeStorageSet(THEME_KEY, theme);
    applyTheme(theme);
    if (theme !== "system") return;
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const listener = () => applyTheme("system");
    query.addEventListener?.("change", listener);
    return () => query.removeEventListener?.("change", listener);
  }, [theme]);

  useEffect(() => {
    safeStorageSet(LINKS_KEY, linksEnabled ? "1" : "0");
  }, [linksEnabled]);

  useEffect(() => {
    safeStorageSet(LONG_MSG_KEY, longMessages ? "1" : "0");
  }, [longMessages]);

  useEffect(() => {
    safeStorageSet(SHOW_ICONS_KEY, showFriendIcons ? "1" : "0");
  }, [showFriendIcons]);

  useEffect(() => {
    const syncOtherTabs = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) setData(loadData());
      if (event.key === DRAFTS_KEY && event.newValue) setDrafts(loadDrafts());
      if (event.key === READ_KEY && event.newValue) setReadState(loadRead());
      if (event.key === THEME_KEY && event.newValue) setTheme(loadTheme());
      if (event.key === LINKS_KEY) setLinksEnabled(loadLinksEnabled());
      if (event.key === LONG_MSG_KEY) setLongMessages(loadLongMessages());
      if (event.key === SHOW_ICONS_KEY) setShowFriendIcons(loadShowFriendIcons());
    };
    window.addEventListener("storage", syncOtherTabs);
    return () => window.removeEventListener("storage", syncOtherTabs);
  }, []);

  useEffect(() => {
    const removeExpired = () => mutate((draft) => pruneEverything(draft));
    const timer = window.setInterval(removeExpired, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [mutate]);

  useEffect(() => {
    if (activeId && data.accounts.some((account) => account.id === activeId)) {
      safeSessionSet(SESSION_KEY, activeId);
      return;
    }
    const fallback = data.accounts[0]?.id ?? "";
    setActiveId(fallback);
    if (fallback) safeSessionSet(SESSION_KEY, fallback);
    else safeSessionRemove(SESSION_KEY);
  }, [activeId, data.accounts]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /* ---------------------- visibility (document.hidden) -------------------- */

  useEffect(() => {
    const handleVisibility = () => {
      const isHidden = document.hidden;
      connectionsRef.current.forEach((conn) => {
        if (conn.open && activeIdRef.current) {
          conn.send({
            type: "visibility",
            senderId: activeIdRef.current,
            hidden: isHidden,
          } satisfies Packet);
        }
      });
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);
    window.addEventListener("blur", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
      window.removeEventListener("blur", handleVisibility);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTyping((current) => {
        const cutoff = Date.now() - 4000;
        const next = Object.fromEntries(Object.entries(current).filter(([, info]) => info.at > cutoff));
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    }, 1200);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape") {
        setShowEmoji(false);
        setAccountMenu(false);
        setSelectionMode(false);
        setCheckedMessages([]);
        if ((event.target as HTMLElement | null)?.tagName === "INPUT") setSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ------------------------------ derived data ---------------------------- */

  const active = data.accounts.find((account) => account.id === activeId);
  const friends = useMemo(() => (active ? data.friends[active.id] ?? [] : []), [active, data.friends]);
  const groups = useMemo(() => (active ? data.groups[active.id] ?? [] : []), [active, data.groups]);
  const selectedFriend = selected.startsWith("friend:") ? friends.find((friend) => friend.id === selected.slice(7)) : undefined;
  const selectedGroup = selected.startsWith("group:") ? groups.find((group) => group.id === selected.slice(6)) : undefined;
  const selectedChatId = selectedFriend?.id ?? selectedGroup?.id ?? "";
  const messages = useMemo(
    () => (active && selectedChatId ? (data.messages[active.id]?.[selectedChatId] ?? []).slice().sort((a, b) => a.sentAt - b.sentAt) : []),
    [active, selectedChatId, data.messages]
  );

  const storageBytes = useMemo(
    () => JSON.stringify(data).length + JSON.stringify(drafts).length + JSON.stringify(readState).length,
    [data, drafts, readState]
  );

  /* --------------------------- drafts & read state ------------------------ */

  useEffect(() => {
    if (!active || !selectedChatId) {
      setMessageText("");
      return;
    }
    setMessageText(draftsRef.current[active.id]?.[selectedChatId] ?? "");
  }, [active?.id, selectedChatId]);

  const updateDraft = useCallback((value: string) => {
    setMessageText(value);
    const ownerId = activeIdRef.current;
    if (!ownerId || !selectedChatId) return;
    setDrafts((prev) => ({ ...prev, [ownerId]: { ...(prev[ownerId] ?? {}), [selectedChatId]: value } }));
  }, [selectedChatId]);

  const forgetChatMeta = useCallback((ownerId: string, chatId: string) => {
    setDrafts((prev) => {
      if (!prev[ownerId]?.[chatId]) return prev;
      const next = { ...prev, [ownerId]: { ...prev[ownerId] } };
      delete next[ownerId][chatId];
      return next;
    });
    setReadState((prev) => {
      if (prev[ownerId]?.[chatId] === undefined) return prev;
      const next = { ...prev, [ownerId]: { ...prev[ownerId] } };
      delete next[ownerId][chatId];
      return next;
    });
  }, []);

  const lastMessageAt = messages.at(-1)?.sentAt ?? 0;
  useEffect(() => {
    if (!active || !selectedChatId || !lastMessageAt) return;
    setReadState((prev) => {
      if ((prev[active.id]?.[selectedChatId] ?? 0) >= lastMessageAt) return prev;
      return { ...prev, [active.id]: { ...(prev[active.id] ?? {}), [selectedChatId]: lastMessageAt } };
    });
    if (selectedFriend) {
      const conn = connectionsRef.current.get(selectedFriend.peerId);
      conn?.send({ type: "read", senderId: active.id, chatId: selectedFriend.id, upTo: lastMessageAt } satisfies Packet);
    }
  }, [active?.id, selectedChatId, selectedFriend?.peerId, lastMessageAt]);

  const unreadCounts = useMemo(() => {
    if (!active) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    const threads = data.messages[active.id] ?? {};
    const read = readState[active.id] ?? {};
    Object.entries(threads).forEach(([chatId, list]) => {
      const lastRead = read[chatId] ?? 0;
      const unread = list.filter((message) => message.senderId !== active.id && message.sentAt > lastRead).length;
      if (unread) counts[chatId] = unread;
    });
    return counts;
  }, [data.messages, readState, active]);

  const totalUnread = useMemo(() => Object.values(unreadCounts).reduce((sum, n) => sum + n, 0), [unreadCounts]);

  /* ------------------- title with notification dot ------------------------ */

  useEffect(() => {
    const title = totalUnread > 0 ? "●Chasy P" : "Chasy P";
    document.title = title;
    try {
      if (window.parent && window.parent !== window) window.parent.document.title = title;
    } catch {
      /* cross-origin iframe */
    }
  }, [totalUnread]);

  /* ----------------- 1-month offline friend deletion rule ----------------- */

  /**
   * ONLY friends for whom a removal request has been submitted AND who have not
   * gone online even once for 1 month (30 days) since that request was made.
   * If no removal request was submitted, friends remain indefinitely!
   */
  const timedOutRemovalFriends = useMemo(() => {
    if (!active) return [];
    const now = Date.now();
    return friends.filter((friend) => {
      if (friend.relation !== "active") return false;
      if (friend.deleteRequest?.direction !== "out") return false;
      const reqAt = friend.deleteRequest.requestedAt || 0;
      if (!reqAt || now - reqAt < MONTH) return false;
      const lastSeen = Math.max(data.presence[active.id]?.[friend.id] ?? 0, friend.addedAt ?? 0);
      const hasBeenOnlineSince = lastSeen > reqAt || onlinePeers.has(friend.peerId);
      return !hasBeenOnlineSince;
    });
  }, [active, friends, data.presence, onlinePeers]);

  const lastSeenOf = useCallback((friendId: string, addedAt: number) => {
    if (!active) return addedAt;
    return Math.max(data.presence[active.id]?.[friendId] ?? 0, addedAt ?? 0);
  }, [active, data.presence]);

  /* ------------------------------ data helpers ---------------------------- */

  const ensureOwnerBuckets = (draft: LocalData, ownerId: string) => {
    draft.friends[ownerId] ??= [];
    draft.messages[ownerId] ??= {};
    draft.groups[ownerId] ??= [];
    draft.receipts[ownerId] ??= {};
    draft.presence[ownerId] ??= {};
    draft.groupDeletions[ownerId] ??= [];
  };

  const addOrUpdateFriend = useCallback((ownerId: string, profile: Profile) => {
    mutate((draft) => {
      ensureOwnerBuckets(draft, ownerId);
      const list = draft.friends[ownerId];
      const existing = list.find((friend) => friend.id === profile.id || friend.peerId === profile.peerId);
      if (existing) {
        existing.nickname = profile.nickname;
        existing.bio = profile.bio;
        existing.color = profile.color;
        existing.peerId = profile.peerId;
        if (existing.relation === "blockedByThem") existing.relation = "active";
      } else {
        list.push({ ...profile, addedAt: Date.now(), relation: "active" });
      }
    });
  }, [mutate]);

  const removeFriendLocally = useCallback((ownerId: string, friendId: string) => {
    const removedGroups = (dataRef.current.groups[ownerId] ?? []).filter((group) => group.creatorId === friendId).map((group) => group.id);
    mutate((draft) => {
      draft.friends[ownerId] = (draft.friends[ownerId] ?? []).filter((friend) => friend.id !== friendId);
      if (draft.messages[ownerId]) delete draft.messages[ownerId][friendId];
      if (draft.receipts[ownerId]) delete draft.receipts[ownerId][friendId];
      if (draft.presence[ownerId]) delete draft.presence[ownerId][friendId];
      draft.groups[ownerId] = (draft.groups[ownerId] ?? [])
        .filter((group) => group.creatorId !== friendId)
        .map((group) => ({ ...group, members: group.members.filter((member) => member.id !== friendId) }));
      removedGroups.forEach((groupId) => { if (draft.messages[ownerId]) delete draft.messages[ownerId][groupId]; });
      draft.groupDeletions[ownerId] = (draft.groupDeletions[ownerId] ?? [])
        .filter((job) => !removedGroups.includes(job.groupId))
        .map((job) => ({ ...job, pendingFor: job.pendingFor.filter((id) => id !== friendId) }))
        .filter((job) => job.pendingFor.length > 0);
      draft.outbox = draft.outbox.filter((item) => !(item.ownerId === ownerId && item.toId === friendId));
    });
    forgetChatMeta(ownerId, friendId);
    removedGroups.forEach((groupId) => forgetChatMeta(ownerId, groupId));
    if (activeIdRef.current === ownerId && selected === `friend:${friendId}`) setSelected("");
  }, [mutate, selected, forgetChatMeta]);

  const queueControl = useCallback((ownerId: string, friend: Pick<Friend, "id" | "peerId">, action: ControlAction, payload: unknown) => {
    const item: OutboxItem = { id: uid(), ownerId, toId: friend.id, toPeerId: friend.peerId, action, payload };
    mutate((draft) => {
      draft.outbox.push(item);
      if (draft.outbox.length > OUTBOX_LIMIT) draft.outbox = draft.outbox.slice(-OUTBOX_LIMIT);
    });
    const conn = connectionsRef.current.get(friend.peerId);
    if (conn?.open) conn.send({ type: "control", eventId: item.id, senderId: ownerId, action, payload } satisfies Packet);
  }, [mutate]);

  const queueGroupDeletion = useCallback((ownerId: string, groupId: string, senderId: string, senderName: string, entries: { id: string; sentAt: number }[], pendingFor: string[]) => {
    const targets = Array.from(new Set(pendingFor)).filter((id) => id !== ownerId);
    if (!targets.length) return;
    mutate((draft) => {
      ensureOwnerBuckets(draft, ownerId);
      const list = draft.groupDeletions[ownerId];
      list.push({ id: uid(), groupId, senderId, senderName, entries, pendingFor: targets, createdAt: Date.now() });
      if (list.length > GROUP_DELETION_LIMIT) draft.groupDeletions[ownerId] = list.slice(-GROUP_DELETION_LIMIT);
    });
  }, [mutate]);

  const upsertIncomingGroup = useCallback((ownerId: string, group: Group) => {
    mutate((draft) => {
      ensureOwnerBuckets(draft, ownerId);
      const list = draft.groups[ownerId];
      const index = list.findIndex((item) => item.id === group.id);
      if (index === -1) {
        list.push(group);
        return;
      }
      const existing = list[index];
      if (existing.creatorId === group.creatorId && existing.createdAt === group.createdAt) list[index] = group;
    });
  }, [mutate]);

  const appendMessage = useCallback((ownerId: string, message: ChatMessage) => {
    mutate((draft) => {
      ensureOwnerBuckets(draft, ownerId);
      const thread = draft.messages[ownerId][message.chatId] ?? [];
      if (thread.some((item) => item.id === message.id)) return;
      thread.push(message);
      const group = (draft.groups[ownerId] ?? []).find((item) => item.id === message.chatId);
      draft.messages[ownerId][message.chatId] = pruneThread(thread, threadLimit(!!group, group?.members.length ?? 0));
    });
  }, [mutate]);

  const hasMessage = useCallback((ownerId: string, chatId: string, messageId: string) => {
    return (dataRef.current.messages[ownerId]?.[chatId] ?? []).some((item) => item.id === messageId);
  }, []);

  const applyDeletionLogs = useCallback((ownerId: string, senderId: string, senderName: string, payload: DeletionPayload) => {
    const threadId = payload.scope === "group" ? payload.chatId : senderId;
    const thread = dataRef.current.messages[ownerId]?.[threadId] ?? [];
    const ids = new Set(
      payload.entries
        .map((entry) => thread.find((message) => message.id === entry.id))
        .filter((message): message is ChatMessage => !!message && message.senderId === senderId && message.kind !== "deletion-log")
        .map((message) => message.id)
    );
    if (!ids.size) return false;
    mutate((draft) => {
      const list = draft.messages[ownerId]?.[threadId];
      if (!list) return;
      list.forEach((message, index) => {
        if (!ids.has(message.id)) return;
        list[index] = {
          id: message.id,
          chatId: threadId,
          senderId,
          senderName,
          text: "",
          kind: "deletion-log",
          sentAt: message.sentAt,
          status: "sent",
        };
      });
      pruneOwnerThreads(draft, ownerId);
    });
    return true;
  }, [mutate]);

  /* -------------------------------- transport ----------------------------- */

  const openConnFor = useCallback((ownerId: string, peerId: string) => {
    const friend = (dataRef.current.friends[ownerId] ?? []).find((item) => item.peerId === peerId);
    if (!friend || friend.relation !== "active") return undefined;
    const conn = connectionsRef.current.get(peerId);
    return conn?.open ? conn : undefined;
  }, []);

  const myPeerId = useCallback((ownerId: string) => {
    return dataRef.current.accounts.find((account) => account.id === ownerId)?.peerId ?? "";
  }, []);

  const forwardGroupPacket = useCallback((ownerId: string, packet: Packet & Hop, group: Group) => {
    const me = myPeerId(ownerId);
    const nextHops = (packet.hops ?? 0) + 1;
    const pending: string[] = [];
    if (nextHops <= MAX_HOPS) {
      group.members.forEach((member) => {
        if (member.id === ownerId || member.peerId === me || member.peerId === packet.via) return;
        const conn = openConnFor(ownerId, member.peerId);
        if (conn) conn.send({ ...packet, hops: nextHops, via: me } satisfies Packet & Hop);
        else pending.push(member.id);
      });
    }
    return pending;
  }, [myPeerId, openConnFor]);

  const flushForConnection = useCallback((conn: DataConnection, ownerId: string) => {
    const snapshot = dataRef.current;
    const friend = (snapshot.friends[ownerId] ?? []).find((item) => item.peerId === conn.peer);
    if (!friend || friend.relation === "blocked") return;
    const me = snapshot.accounts.find((account) => account.id === ownerId)?.peerId ?? "";

    const direct = snapshot.messages[ownerId]?.[friend.id] ?? [];
    direct.filter((message) => message.status === "queued" && message.kind !== "deletion-log").forEach((message) => {
      conn.send({ type: "chat", message: { ...message, status: "sent" } } satisfies Packet);
    });

    const delivered: string[] = [];
    const handedOff: string[] = [];
    Object.values(snapshot.messages[ownerId] ?? {}).flat().forEach((message) => {
      if (!message.pendingFor?.length) return;
      const group = (snapshot.groups[ownerId] ?? []).find((item) => item.id === message.chatId);
      if (!group) return;
      const isTarget = message.pendingFor.includes(friend.id);
      if (!isTarget && !group.members.some((member) => member.id === friend.id)) return;
      conn.send({ type: "group-chat", message: { ...message, status: "sent" }, group, hops: 1, via: me } satisfies Packet & Hop);
      (isTarget ? delivered : handedOff).push(message.id);
    });

    snapshot.outbox.filter((item) => item.ownerId === ownerId && item.toId === friend.id).forEach((item) => {
      conn.send({ type: "control", eventId: item.id, senderId: ownerId, action: item.action, payload: item.payload } satisfies Packet);
    });

    const deletionJobs = snapshot.groupDeletions[ownerId] ?? [];
    const resolvedJobIds: string[] = [];
    if (deletionJobs.length) {
      const ownerGroups = snapshot.groups[ownerId] ?? [];
      deletionJobs.forEach((job) => {
        const jobGroup = ownerGroups.find((item) => item.id === job.groupId);
        if (!jobGroup || !jobGroup.members.some((member) => member.id === friend.id)) return;
        const payload: DeletionPayload = { chatId: job.groupId, scope: "group", entries: job.entries };
        conn.send({ type: "group-control", eventId: uid(), senderId: job.senderId, action: "messages-deleted", payload, group: jobGroup, hops: 0, via: me } satisfies Packet & Hop);
        if (job.pendingFor.includes(friend.id)) resolvedJobIds.push(job.id);
      });
    }

    mutate((draft) => {
      const thread = draft.messages[ownerId]?.[friend.id] ?? [];
      thread.forEach((message) => { if (message.status === "queued" && message.kind !== "deletion-log") message.status = "sent"; });
      Object.values(draft.messages[ownerId] ?? {}).flat().forEach((message) => {
        if (handedOff.includes(message.id)) {
          message.pendingFor = [];
          message.status = "sent";
          return;
        }
        if (!delivered.includes(message.id)) return;
        message.pendingFor = (message.pendingFor ?? []).filter((id) => id !== friend.id);
        if (message.pendingFor.length === 0) message.status = "sent";
      });
      if (resolvedJobIds.length) {
        draft.groupDeletions[ownerId] = (draft.groupDeletions[ownerId] ?? [])
          .map((job) => (resolvedJobIds.includes(job.id)
            ? { ...job, pendingFor: job.pendingFor.filter((id) => id !== friend.id) }
            : job))
          .filter((job) => job.pendingFor.length > 0);
      }
    });
  }, [mutate]);

  openHandlerRef.current = (conn, ownerId) => {
    const profile = dataRef.current.accounts.find((account) => account.id === ownerId);
    if (!profile) return;
    conn.send({
      type: "hello",
      profile,
      hidden: document.hidden,
      avatarImage: profile.avatarImage || null,
    } satisfies Packet);
    flushForConnection(conn, ownerId);
  };

  packetHandlerRef.current = (packet, conn, ownerId) => {
    const snapshot = dataRef.current;
    const ownerFriends = snapshot.friends[ownerId] ?? [];
    const neighbour = ownerFriends.find((item) => item.peerId === conn.peer);
    if (!neighbour) {
      conn.close();
      return;
    }

    if (packet.type === "hello") {
      if (neighbour.relation === "blocked") {
        conn.send({ type: "friend-block", senderId: ownerId } satisfies Packet);
        window.setTimeout(() => conn.close(), 80);
        return;
      }
      if (packet.hidden !== undefined) {
        setPeerHidden((prev) => ({ ...prev, [conn.peer]: packet.hidden! }));
      }
      if (packet.avatarImage) {
        setEphemeralAvatars((prev) => ({ ...prev, [packet.profile.id]: packet.avatarImage! }));
      }
      mutate((draft) => {
        const target = (draft.friends[ownerId] ?? []).find((item) => item.id === packet.profile.id);
        if (target) {
          target.nickname = packet.profile.nickname;
          target.bio = packet.profile.bio;
          target.color = packet.profile.color;
        }
      });
      flushForConnection(conn, ownerId);
      return;
    }

    if (neighbour.relation !== "active") return;

    if (packet.type === "visibility") {
      setPeerHidden((prev) => ({ ...prev, [conn.peer]: packet.hidden }));
      return;
    }

    if (packet.type === "avatar-share") {
      setEphemeralAvatars((prev) => {
        if (!packet.avatarImage) {
          const next = { ...prev };
          delete next[packet.senderId];
          return next;
        }
        return { ...prev, [packet.senderId]: packet.avatarImage };
      });
      return;
    }

    if (packet.type === "chat") {
      if (packet.message.senderId !== neighbour.id) return;
      appendMessage(ownerId, { ...packet.message, chatId: neighbour.id, status: "sent", pendingFor: [] });
      conn.send({ type: "message-ack", messageId: packet.message.id } satisfies Packet);
      return;
    }

    if (packet.type === "group-chat") {
      const group = packet.group;
      if (!group || !group.members.some((member) => member.id === ownerId)) return;
      if (!group.members.some((member) => member.id === packet.message.senderId)) return;
      upsertIncomingGroup(ownerId, group);
      if (hasMessage(ownerId, packet.message.chatId, packet.message.id)) {
        conn.send({ type: "message-ack", messageId: packet.message.id } satisfies Packet);
        return;
      }
      const pending = forwardGroupPacket(ownerId, packet, group);
      appendMessage(ownerId, { ...packet.message, status: "sent", pendingFor: pending });
      conn.send({ type: "message-ack", messageId: packet.message.id } satisfies Packet);
      return;
    }

    if (packet.type === "group-control") {
      const group = packet.group;
      if (!group || !group.members.some((member) => member.id === ownerId)) return;
      if (packet.action === "messages-deleted") {
        const senderName = group.members.find((member) => member.id === packet.senderId)?.nickname ?? neighbour.nickname;
        const payload = packet.payload as DeletionPayload;
        const changed = applyDeletionLogs(ownerId, packet.senderId, senderName, payload);
        if (changed) {
          const stillPending = forwardGroupPacket(ownerId, packet, group);
          if (stillPending.length) queueGroupDeletion(ownerId, group.id, packet.senderId, senderName, payload.entries, stillPending);
        }
      }
      return;
    }

    if (packet.type === "message-ack") {
      mutate((draft) => {
        Object.values(draft.messages[ownerId] ?? {}).flat().forEach((message) => {
          if (message.id === packet.messageId) message.status = "sent";
        });
      });
      return;
    }

    if (packet.type === "typing") {
      const localChatId = packet.scope === "group" ? packet.chatId : neighbour.id;
      setTyping((current) => ({ ...current, [neighbour.id]: { chatId: localChatId, at: Date.now() } }));
      return;
    }

    if (packet.type === "read") {
      if (packet.chatId !== ownerId || packet.senderId !== neighbour.id) return;
      mutate((draft) => {
        ensureOwnerBuckets(draft, ownerId);
        const previous = draft.receipts[ownerId][neighbour.id] ?? 0;
        if (packet.upTo > previous) draft.receipts[ownerId][neighbour.id] = packet.upTo;
      });
      return;
    }

    if (packet.type === "friend-block") {
      mutate((draft) => {
        const friend = (draft.friends[ownerId] ?? []).find((item) => item.id === packet.senderId);
        if (friend && friend.relation !== "blocked") friend.relation = "blockedByThem";
      });
      setToast("This connection was blocked by your friend.");
      window.setTimeout(() => conn.close(), 80);
      return;
    }

    if (packet.type === "friend-unblock") {
      mutate((draft) => {
        const friend = (draft.friends[ownerId] ?? []).find((item) => item.id === packet.senderId);
        if (friend?.relation === "blockedByThem") friend.relation = "active";
      });
      return;
    }

    if (packet.type === "delete-request") {
      if (packet.senderId !== neighbour.id) return;
      mutate((draft) => {
        const target = (draft.friends[ownerId] ?? []).find((item) => item.id === packet.senderId);
        if (target) target.deleteRequest = { id: packet.requestId, direction: "in", requestedAt: Date.now() };
      });
      if (ownerId === activeIdRef.current) setIncomingDelete({ friendId: neighbour.id, requestId: packet.requestId });
      return;
    }

    if (packet.type === "delete-reject") {
      mutate((draft) => {
        const friend = (draft.friends[ownerId] ?? []).find((item) => item.id === packet.senderId);
        if (friend?.deleteRequest?.id === packet.requestId) delete friend.deleteRequest;
      });
      setToast("Your friend chose to keep the connection.");
      return;
    }

    if (packet.type === "delete-confirm") {
      removeFriendLocally(ownerId, packet.senderId);
      setToast("The connection was permanently deleted.");
      return;
    }

    if (packet.type === "purge-request") {
      if (packet.senderId !== neighbour.id) return;
      if (ownerId === activeIdRef.current) setIncomingPurge({ friendId: neighbour.id, requestId: packet.requestId });
      return;
    }

    if (packet.type === "purge-reject") {
      setToast("Your friend declined to erase the conversation.");
      return;
    }

    if (packet.type === "purge-confirm") {
      mutate((draft) => {
        if (draft.messages[ownerId]) delete draft.messages[ownerId][packet.senderId];
      });
      forgetChatMeta(ownerId, packet.senderId);
      setToast("All conversation data with that friend was erased.");
      return;
    }

    if (packet.type === "control") {
      if (packet.action === "group-sync") {
        const group = packet.payload as Group;
        if (group.members.some((member) => member.id === ownerId)) upsertIncomingGroup(ownerId, group);
        else mutate((draft) => { draft.groups[ownerId] = (draft.groups[ownerId] ?? []).filter((item) => item.id !== group.id); });
      }
      if (packet.action === "group-delete") {
        const groupId = String(packet.payload);
        mutate((draft) => {
          draft.groups[ownerId] = (draft.groups[ownerId] ?? []).filter((group) => group.id !== groupId);
          if (draft.messages[ownerId]) delete draft.messages[ownerId][groupId];
          draft.groupDeletions[ownerId] = (draft.groupDeletions[ownerId] ?? []).filter((job) => job.groupId !== groupId);
        });
        forgetChatMeta(ownerId, groupId);
      }
      if (packet.action === "group-leave") {
        const groupId = String(packet.payload);
        const ownerGroup = (snapshot.groups[ownerId] ?? []).find((group) => group.id === groupId);
        if (ownerGroup?.creatorId === ownerId) {
          const updated = { ...ownerGroup, members: ownerGroup.members.filter((member) => member.id !== packet.senderId) };
          upsertIncomingGroup(ownerId, updated);
          ownerFriends
            .filter((friend) => updated.members.some((member) => member.id === friend.id))
            .forEach((friend) => queueControl(ownerId, friend, "group-sync", updated));
        }
      }
      if (packet.action === "messages-deleted") {
        applyDeletionLogs(ownerId, packet.senderId, neighbour.nickname, packet.payload as DeletionPayload);
      }
      if (packet.action === "friend-removed") {
        removeFriendLocally(ownerId, packet.senderId);
        setToast(`${neighbour.nickname} removed the connection after remaining offline.`);
      }
      conn.send({ type: "control-ack", eventId: packet.eventId } satisfies Packet);
      return;
    }

    if (packet.type === "control-ack") {
      mutate((draft) => { draft.outbox = draft.outbox.filter((item) => item.id !== packet.eventId); });
      return;
    }

    if (packet.type === "account-deleted") {
      const gone = ownerFriends.find((item) => item.id === packet.senderId);
      if (gone && gone.peerId === packet.peerId) {
        removeFriendLocally(ownerId, packet.senderId);
        setToast(`${gone.nickname} deleted their account and was removed from your list.`);
      }
      conn.send({ type: "account-deleted-ack", senderId: ownerId } satisfies Packet);
      return;
    }
  };

  useEffect(() => {
    if (!active) {
      setNetworkState("offline");
      return;
    }
    let disposed = false;
    let currentPeer: Peer | null = null;
    let idRetryTimer: number | null = null;
    setNetworkState("connecting");
    setOnlinePeers(new Set());
    setPeerHidden({});
    setEphemeralAvatars({});
    connectionsRef.current.clear();

    const attachConnection = (conn: DataConnection) => {
      conn.on("open", () => {
        if (disposed) return;
        const existing = connectionsRef.current.get(conn.peer);
        if (existing?.open && existing !== conn) {
          conn.close();
          return;
        }
        connectionsRef.current.set(conn.peer, conn);
        setOnlinePeers((current) => new Set(current).add(conn.peer));
        mutate((draft) => {
          ensureOwnerBuckets(draft, active.id);
          const seen = draft.friends[active.id].find((item) => item.peerId === conn.peer);
          if (seen) draft.presence[active.id][seen.id] = Date.now();
        });
        // Send our visibility state and active custom avatar immediately
        conn.send({ type: "visibility", senderId: active.id, hidden: document.hidden } satisfies Packet);
        if (active.avatarImage) {
          conn.send({ type: "avatar-share", senderId: active.id, avatarImage: active.avatarImage } satisfies Packet);
        }
        openHandlerRef.current?.(conn, active.id);
      });
      conn.on("data", (payload) => packetHandlerRef.current?.(payload as Packet, conn, active.id));
      conn.on("close", () => {
        if (connectionsRef.current.get(conn.peer) === conn) connectionsRef.current.delete(conn.peer);
        setOnlinePeers((current) => {
          const next = new Set(current);
          next.delete(conn.peer);
          return next;
        });
        setPeerHidden((current) => {
          const next = { ...current };
          delete next[conn.peer];
          return next;
        });
        const friend = dataRef.current.friends[activeIdRef.current]?.find((item) => item.peerId === conn.peer);
        if (friend) {
          setEphemeralAvatars((prev) => {
            if (!prev[friend.id]) return prev;
            const next = { ...prev };
            delete next[friend.id];
            return next;
          });
        }
      });
      conn.on("error", () => undefined);
      return conn;
    };

    const connectTo = (peerId: string) => {
      if (!currentPeer?.open || disposed) return null;
      const existing = connectionsRef.current.get(peerId);
      if (existing?.open) return existing;
      return attachConnection(currentPeer.connect(peerId, { reliable: true, metadata: { kind: "friend", from: active.id } }));
    };
    connectToRef.current = connectTo;

    const connectFriends = () => {
      const currentFriends = dataRef.current.friends[active.id] ?? [];
      currentFriends.forEach((friend) => {
        if (friend.relation !== "active") return;
        const ordered = active.peerId < friend.peerId;
        if (!ordered && !forceDialRef.current.has(friend.peerId)) return;
        if (connectTo(friend.peerId)?.open) forceDialRef.current.delete(friend.peerId);
      });
    };

    const reconnectTimer = window.setInterval(connectFriends, 7000);

    const spawn = (attempt: number) => {
      if (disposed) return;
      const peer = new Peer(active.peerId, { debug: 0 });
      currentPeer = peer;
      peerRef.current = peer;

      peer.on("open", () => {
        if (disposed || currentPeer !== peer) return;
        setNetworkState("online");
        connectFriends();
      });
      peer.on("connection", attachConnection);
      peer.on("disconnected", () => {
        if (disposed || currentPeer !== peer) return;
        setNetworkState("offline");
        window.setTimeout(() => {
          if (!disposed && currentPeer === peer && !peer.destroyed) {
            try { peer.reconnect(); } catch { /* ignore */ }
          }
        }, 2500);
      });
      peer.on("error", (error) => {
        if (disposed || currentPeer !== peer) return;
        if (error.type === "unavailable-id") {
          setNetworkState("offline");
          if (attempt < 5) {
            idRetryTimer = window.setTimeout(() => {
              if (disposed) return;
              peer.destroy();
              spawn(attempt + 1);
            }, 2000 * (attempt + 1));
          } else {
            setToast("This identity is already open in another tab or device.");
          }
        } else if (["network", "server-error", "socket-error", "socket-closed"].includes(error.type)) {
          setNetworkState("offline");
        }
      });
    };

    spawn(0);

    return () => {
      disposed = true;
      if (idRetryTimer !== null) window.clearTimeout(idRetryTimer);
      window.clearInterval(reconnectTimer);
      connectionsRef.current.forEach((conn) => conn.close());
      connectionsRef.current.clear();
      connectToRef.current = null;
      forceDialRef.current.clear();
      currentPeer?.destroy();
      if (peerRef.current === currentPeer) peerRef.current = null;
    };
  }, [active?.id, active?.peerId]);

  const pendingNotices = useMemo(
    () => data.tombstones.reduce((sum, tombstone) => sum + tombstone.targets.length, 0),
    [data.tombstones]
  );
  const tombstoneSignature = `${data.tombstones.map((item) => `${item.peerId}:${item.targets.map((target) => target.peerId).join(",")}`).join("|")}#${notifyTick}`;

  useEffect(() => {
    if (!data.tombstones.length) return;
    let cancelled = false;
    const peers: Peer[] = [];
    const timers: number[] = [];
    const inFlight = new Set<string>();

    const settle = (tombstonePeerId: string, targetPeerId: string) => {
      mutate((draft) => {
        const marker = draft.tombstones.find((item) => item.peerId === tombstonePeerId);
        if (marker) marker.targets = marker.targets.filter((item) => item.peerId !== targetPeerId);
        draft.tombstones = draft.tombstones.filter((item) => item.targets.length > 0);
      });
      setDeliveredNotices((n) => n + 1);
    };

    const notifyTargets = (peer: Peer, tombstone: Tombstone) => {
      const current = dataRef.current.tombstones.find((item) => item.peerId === tombstone.peerId);
      current?.targets.forEach((target) => {
        if (inFlight.has(target.peerId)) return;
        inFlight.add(target.peerId);
        let conn: DataConnection;
        try {
          conn = peer.connect(target.peerId, { reliable: true, metadata: { kind: "account-deletion" } });
        } catch {
          inFlight.delete(target.peerId);
          return;
        }
        const release = () => {
          inFlight.delete(target.peerId);
          window.clearTimeout(giveUp);
          try { conn.close(); } catch { /* ignore */ }
        };
        const giveUp = window.setTimeout(release, 9000);
        conn.on("open", () => {
          if (cancelled) return release();
          conn.send({ type: "account-deleted", senderId: tombstone.accountId, peerId: tombstone.peerId } satisfies Packet);
        });
        conn.on("data", (payload) => {
          if ((payload as Packet).type !== "account-deleted-ack") return;
          release();
          settle(tombstone.peerId, target.peerId);
          setToast("A former friend was told this account no longer exists.");
        });
        conn.on("error", release);
        conn.on("close", () => inFlight.delete(target.peerId));
      });
    };

    const peer = new Peer("", { debug: 0 });
    peers.push(peer);
    peer.on("open", () => {
      if (cancelled) return;
      setNoticeState("online");
      const run = () => {
        if (cancelled) return;
        dataRef.current.tombstones.forEach((tombstone) => notifyTargets(peer, tombstone));
      };
      run();
      timers.push(window.setInterval(run, 20000));
    });
    peer.on("disconnected", () => {
      if (cancelled) return;
      setNoticeState("retrying");
      try { peer.reconnect(); } catch { /* ignore */ }
    });
    peer.on("error", () => {
      if (!cancelled) setNoticeState("retrying");
    });

    return () => {
      cancelled = true;
      timers.forEach((id) => { window.clearInterval(id); window.clearTimeout(id); });
      peers.forEach((item) => { try { item.destroy(); } catch { /* ignore */ } });
    };
  }, [tombstoneSignature, mutate]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: atBottom ? "smooth" : "auto", block: "end" });
  }, [messages.length, selected, atBottom]);

  useEffect(() => {
    setSelected("");
    setMobileChat(false);
    setAccountMenu(false);
    setEphemeralAvatars({});
    setPeerHidden({});
  }, [activeId]);

  useEffect(() => {
    setSelectionMode(false);
    setCheckedMessages([]);
    setShowEmoji(false);
    setAtBottom(true);
  }, [selected]);

  /* -------------------------------- actions ------------------------------- */

  const notify = (text: string) => setToast(text);

  const handleCopy = (text: string, label = "Copied") => {
    if (!text) return;
    copyText(text).then((ok) => notify(ok ? label : "Copying is blocked in this browser"));
  };

  const createFirstAccount = (profile: Profile) => {
    mutate((draft) => {
      draft.accounts.push(profile);
      ensureOwnerBuckets(draft, profile.id);
    });
    setActiveId(profile.id);
  };

  const createAdditionalAccount = (profile: Profile) => {
    if (dataRef.current.accounts.length >= 5) return;
    mutate((draft) => {
      draft.accounts.push(profile);
      ensureOwnerBuckets(draft, profile.id);
    });
    setActiveId(profile.id);
    setModal(null);
    notify("New identity created on this device.");
  };

  const saveProfile = (nickname: string, bio: string, avatarImage: string | null) => {
    if (!active) return;
    const currentAccount = active;
    mutate((draft) => {
      const account = draft.accounts.find((item) => item.id === currentAccount.id);
      if (!account) return;
      account.nickname = nickname;
      account.bio = bio;
      account.avatarImage = avatarImage || undefined;
      Object.keys(draft.groups).forEach((ownerId) => {
        draft.groups[ownerId] = draft.groups[ownerId].map((group) => ({
          ...group,
          members: group.members.map((member) => member.id === currentAccount.id ? { ...member, nickname, bio, avatarImage: avatarImage || undefined } : member),
        }));
      });
    });
    connectionsRef.current.forEach((conn) => {
      if (conn.open) {
        conn.send({ type: "hello", profile: { ...currentAccount, nickname, bio, avatarImage: avatarImage || undefined } } satisfies Packet);
        conn.send({ type: "avatar-share", senderId: currentAccount.id, avatarImage: avatarImage || null } satisfies Packet);
      }
    });
    setModal(null);
    notify("Profile updated.");
  };

  const deleteActiveAccount = () => {
    if (!active) return;
    const accountId = active.id;
    const targets = (data.friends[accountId] ?? []).map((friend) => ({ id: friend.id, peerId: friend.peerId }));
    connectionsRef.current.forEach((conn) => {
      if (conn.open) conn.send({ type: "account-deleted", senderId: accountId, peerId: active.peerId } satisfies Packet);
    });
    mutate((draft) => {
      if (targets.length) draft.tombstones.push({ accountId, peerId: active.peerId, targets });
      draft.accounts = draft.accounts.filter((account) => account.id !== accountId);
      delete draft.friends[accountId];
      delete draft.messages[accountId];
      delete draft.groups[accountId];
      delete draft.receipts[accountId];
      delete draft.presence[accountId];
      delete draft.groupDeletions[accountId];
      draft.outbox = draft.outbox.filter((item) => item.ownerId !== accountId);
      Object.keys(draft.friends).forEach((ownerId) => {
        draft.friends[ownerId] = draft.friends[ownerId].filter((friend) => friend.id !== accountId);
      });
      Object.keys(draft.groups).forEach((ownerId) => {
        const removedGroupIds = draft.groups[ownerId].filter((group) => group.creatorId === accountId).map((group) => group.id);
        draft.groups[ownerId] = draft.groups[ownerId]
          .filter((group) => group.creatorId !== accountId)
          .map((group) => ({ ...group, members: group.members.filter((member) => member.id !== accountId) }));
        removedGroupIds.forEach((groupId) => { if (draft.messages[ownerId]) delete draft.messages[ownerId][groupId]; });
      });
      Object.keys(draft.groupDeletions).forEach((ownerId) => {
        draft.groupDeletions[ownerId] = (draft.groupDeletions[ownerId] ?? [])
          .map((job) => ({ ...job, pendingFor: job.pendingFor.filter((id) => id !== accountId) }))
          .filter((job) => job.pendingFor.length > 0);
      });
    });
    setDrafts((prev) => { const next = { ...prev }; delete next[accountId]; return next; });
    setReadState((prev) => { const next = { ...prev }; delete next[accountId]; return next; });
    setActiveId(data.accounts.find((account) => account.id !== accountId)?.id ?? "");
    setModal(null);
    notify(targets.length ? "Identity deleted — friends will be told when they next connect." : "Identity deleted.");
  };

  const eraseDevice = () => {
    connectionsRef.current.forEach((conn) => conn.close());
    connectionsRef.current.clear();
    [STORAGE_KEY, DRAFTS_KEY, READ_KEY, THEME_KEY, LINKS_KEY, LONG_MSG_KEY, SHOW_ICONS_KEY].forEach((key) => safeStorageRemove(key));
    safeSessionRemove(SESSION_KEY);
    setData(emptyData());
    setDrafts({});
    setReadState({});
    setActiveId("");
    setSelected("");
    setModal(null);
    notify("Every local trace was erased.");
  };

  const finishInvite = useCallback((profile: Profile) => {
    const owner = dataRef.current.accounts.find((account) => account.id === activeIdRef.current);
    if (!owner) return;
    if (profile.id === owner.id) {
      setInviteStatus("You cannot add the same identity.");
      return;
    }
    const localIdentity = dataRef.current.accounts.find((account) => account.id === profile.id);
    if (localIdentity) {
      mutate((draft) => {
        ensureOwnerBuckets(draft, owner.id);
        ensureOwnerBuckets(draft, localIdentity.id);
        if (!draft.friends[owner.id].some((friend) => friend.id === localIdentity.id)) {
          draft.friends[owner.id].push({ ...localIdentity, addedAt: Date.now(), relation: "active" });
        }
        if (!draft.friends[localIdentity.id].some((friend) => friend.id === owner.id)) {
          draft.friends[localIdentity.id].push({ ...owner, addedAt: Date.now(), relation: "active" });
        }
      });
    } else {
      addOrUpdateFriend(owner.id, profile);
    }
    setInviteStatus(`Connected to ${profile.nickname}. You can close this window.`);
    notify(`${profile.nickname} is now your friend.`);
    if (owner.peerId < profile.peerId) window.setTimeout(() => connectToRef.current?.(profile.peerId), 300);
  }, [addOrUpdateFriend, mutate]);

  const generateInvite = useCallback(() => {
    const owner = dataRef.current.accounts.find((account) => account.id === activeIdRef.current);
    if (!owner) return;
    invitePeerRef.current?.destroy();
    const code = makeCode();
    setInviteCode(code);
    setInviteStatus("Opening the rendezvous...");
    const invitePeer = new Peer(`${INVITE_PREFIX}${code}`, { debug: 0 });
    invitePeerRef.current = invitePeer;
    invitePeer.on("open", () => setInviteStatus("Ready. Keep this window open while your friend enters it."));
    invitePeer.on("connection", (conn) => {
      conn.on("open", () => conn.send({ type: "invite-intro", profile: owner } satisfies Packet));
      conn.on("data", (payload) => {
        const packet = payload as Packet;
        if (packet.type === "invite-intro") finishInvite(packet.profile);
      });
    });
    invitePeer.on("error", (error) => {
      if (error.type === "unavailable-id") {
        setInviteStatus("That number was busy. Generating another...");
        window.setTimeout(generateInvite, 300);
      } else setInviteStatus("Could not open the rendezvous. Check your connection.");
    });
  }, [finishInvite]);

  const joinInvite = (code: string) => {
    const owner = dataRef.current.accounts.find((account) => account.id === activeIdRef.current);
    const peer = peerRef.current;
    if (!owner || !peer?.open) {
      setInviteStatus("Chasy P is offline. Reconnect before using a number.");
      return;
    }
    setInviteStatus("Looking for that number...");
    const conn = peer.connect(`${INVITE_PREFIX}${code}`, { reliable: true, metadata: { kind: "invite" } });
    const timeout = window.setTimeout(() => {
      if (!conn.open) {
        setInviteStatus("No active number was found. Ask your friend to keep it open.");
        conn.close();
      }
    }, 9000);
    conn.on("open", () => {
      window.clearTimeout(timeout);
      conn.send({ type: "invite-intro", profile: owner } satisfies Packet);
    });
    conn.on("data", (payload) => {
      const packet = payload as Packet;
      if (packet.type === "invite-intro") finishInvite(packet.profile);
    });
    conn.on("error", () => setInviteStatus("The connection failed. Check the number and try again."));
  };

  const closeAddDialog = () => {
    invitePeerRef.current?.destroy();
    invitePeerRef.current = null;
    setInviteCode("");
    setInviteStatus("");
    setModal(null);
  };

  const markAllRead = () => {
    if (!active) return;
    const threads = data.messages[active.id] ?? {};
    const stamps = Object.fromEntries(
      Object.entries(threads)
        .map(([chatId, list]) => [chatId, list.at(-1)?.sentAt ?? 0])
        .filter(([, at]) => (at as number) > 0)
    );
    if (!Object.keys(stamps).length) {
      notify("Nothing unread.");
      return;
    }
    setReadState((prev) => ({ ...prev, [active.id]: { ...(prev[active.id] ?? {}), ...stamps } }));
    notify("Everything marked as read.");
  };

  const exportConversation = () => {
    if (!active || !selectedChatId) return;
    const lines = messages.map((message) => {
      const who = message.senderId === active.id ? active.nickname : message.senderName;
      const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(message.sentAt);
      const body = message.kind === "deletion-log" ? "[deleted a message]" : message.kind === "sticker" ? `[sticker] ${message.text}` : message.text;
      return `[${stamp}] ${who}: ${body}`;
    });
    const header = `Chasy P conversation export — ${conversationName}\nExported ${new Date().toLocaleString()}\n${"-".repeat(40)}\n`;
    try {
      const blob = new Blob([header + lines.join("\n") + "\n"], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Chasy_P-${conversationName.replace(/[^a-z0-9-_]+/gi, "_") || "conversation"}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Conversation exported as text.");
    } catch {
      notify("Export blocked by this browser.");
    }
  };

  const exportData = () => {
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Chasy_P-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Backup exported");
    } catch {
      notify("Export blocked — use Import to paste JSON instead.");
    }
  };

  const applyImport = (raw: string) => {
    try {
      const parsed = normalizeData(JSON.parse(raw));
      if (!parsed.accounts.length) throw new Error("empty");
      safeStorageSet(STORAGE_KEY, JSON.stringify(parsed));
      safeStorageRemove(DRAFTS_KEY);
      safeStorageRemove(READ_KEY);
      setData(parsed);
      setDrafts({});
      setReadState({});
      setActiveId(parsed.accounts[0]?.id ?? "");
      setSelected("");
      setModal(null);
      setImportText("");
      notify("Backup restored");
    } catch {
      notify("Import failed — that file is not a Chasy P backup.");
    }
  };

  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => applyImport(String(reader.result));
    reader.onerror = () => notify("Could not read that file.");
    reader.readAsText(file);
  };

  const transferSnapshot = useCallback((): TransferPayload => ({
    kind: "chsyp-transfer",
    version: 1,
    data: dataRef.current,
    drafts: draftsRef.current,
    readState,
    theme,
    linksEnabled,
    longMessages,
    showFriendIcons,
  }), [readState, theme, linksEnabled, longMessages, showFriendIcons]);

  const applyTransfer = useCallback((payload: TransferPayload) => {
    const parsed = normalizeData(payload.data);
    if (!parsed.accounts.length) return false;
    safeStorageSet(STORAGE_KEY, JSON.stringify(parsed));
    safeStorageSet(DRAFTS_KEY, JSON.stringify(payload.drafts ?? {}));
    safeStorageSet(READ_KEY, JSON.stringify(payload.readState ?? {}));
    setData(parsed);
    setDrafts(payload.drafts ?? {});
    setReadState(payload.readState ?? {});
    if (["light", "dark", "system"].includes(payload.theme)) setTheme(payload.theme);
    if (typeof payload.linksEnabled === "boolean") setLinksEnabled(payload.linksEnabled);
    if (typeof payload.longMessages === "boolean") setLongMessages(payload.longMessages);
    if (typeof payload.showFriendIcons === "boolean") setShowFriendIcons(payload.showFriendIcons);
    setActiveId(parsed.accounts[0]?.id ?? "");
    setSelected("");
    notify("Data received from your other device.");
    return true;
  }, []);

  /* ----------------------------- messaging ------------------------------- */

  const sendTypingSignal = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSent.current < 1500) return;
    lastTypingSent.current = now;
    const ownerId = activeIdRef.current;
    const snapshot = dataRef.current;
    if (!selectedChatId || !ownerId) return;
    const group = (snapshot.groups[ownerId] ?? []).find((item) => item.id === selectedChatId);
    if (group) {
      group.members.forEach((member) => {
        if (member.id === ownerId) return;
        openConnFor(ownerId, member.peerId)?.send({ type: "typing", senderId: ownerId, chatId: group.id, scope: "group" } satisfies Packet);
      });
      return;
    }
    const friend = (snapshot.friends[ownerId] ?? []).find((item) => item.id === selectedChatId);
    if (friend) openConnFor(ownerId, friend.peerId)?.send({ type: "typing", senderId: ownerId, chatId: friend.id, scope: "direct" } satisfies Packet);
  }, [selectedChatId, openConnFor]);

  const dispatchGroupMessage = (base: ChatMessage, group: Group) => {
    if (!active) return [];
    const me = active.peerId;
    const unreachable: string[] = [];
    group.members
      .filter((member) => member.id !== active.id)
      .forEach((member) => {
        const direct = openConnFor(active.id, member.peerId);
        if (direct) {
          direct.send({ type: "group-chat", message: { ...base, status: "sent" }, group, hops: 0, via: me } satisfies Packet & Hop);
          return;
        }
        const relay = group.members.find((other) => other.id !== active.id && other.id !== member.id && openConnFor(active.id, other.peerId));
        const relayConn = relay ? openConnFor(active.id, relay.peerId) : undefined;
        if (relayConn) relayConn.send({ type: "group-chat", message: { ...base, status: "sent" }, group, hops: 0, via: me } satisfies Packet & Hop);
        else unreachable.push(member.id);
      });
    return unreachable;
  };

  const sendMessage = (text: string, kind: "text" | "sticker") => {
    if (!active || (!selectedFriend && !selectedGroup) || !text.trim() || text.length > messageLimit) return;
    const base: ChatMessage = {
      id: uid(),
      chatId: selectedChatId,
      senderId: active.id,
      senderName: active.nickname,
      text: text.trim(),
      kind,
      sentAt: Date.now(),
      status: "queued",
    };

    if (selectedFriend) {
      if (selectedFriend.relation !== "active") return;
      const conn = connectionsRef.current.get(selectedFriend.peerId);
      const canSend = Boolean(conn?.open);
      const message: ChatMessage = { ...base, status: canSend ? "sent" : "queued" };
      appendMessage(active.id, message);
      if (canSend && conn) conn.send({ type: "chat", message } satisfies Packet);
    } else if (selectedGroup) {
      const unreachable = dispatchGroupMessage(base, selectedGroup);
      appendMessage(active.id, { ...base, pendingFor: unreachable, status: unreachable.length ? "queued" : "sent" });
    }

    updateDraft("");
    setShowEmoji(false);
    setAtBottom(true);
  };

  const submitMessage = (event: FormEvent) => {
    event.preventDefault();
    sendMessage(messageText, "text");
  };

  const broadcastDeletions = (removed: ChatMessage[]) => {
    if (!active) return;
    const authored = removed.filter((message) => message.senderId === active.id && message.kind !== "deletion-log");
    if (!authored.length) return;
    const entries = authored.map((message) => ({ id: message.id, sentAt: message.sentAt }));

    if (selectedFriend) {
      queueControl(active.id, selectedFriend, "messages-deleted", {
        chatId: selectedFriend.id,
        scope: "direct",
        entries,
      } satisfies DeletionPayload);
      return;
    }

    if (selectedGroup) {
      const payload: DeletionPayload = { chatId: selectedGroup.id, scope: "group", entries };
      const me = active.peerId;
      const unresolved: string[] = [];
      selectedGroup.members
        .filter((member) => member.id !== active.id)
        .forEach((member) => {
          const direct = openConnFor(active.id, member.peerId);
          if (direct) {
            direct.send({ type: "group-control", eventId: uid(), senderId: active.id, action: "messages-deleted", payload, group: selectedGroup, hops: 0, via: me } satisfies Packet & Hop);
            return;
          }
          const relay = selectedGroup.members.find((other) => other.id !== active.id && other.id !== member.id && openConnFor(active.id, other.peerId));
          const relayConn = relay ? openConnFor(active.id, relay.peerId) : undefined;
          if (relayConn) {
            relayConn.send({ type: "group-control", eventId: uid(), senderId: active.id, action: "messages-deleted", payload, group: selectedGroup, hops: 0, via: me } satisfies Packet & Hop);
            return;
          }
          unresolved.push(member.id);
        });
      if (unresolved.length) queueGroupDeletion(active.id, selectedGroup.id, active.id, active.nickname, entries, unresolved);
    }
  };

  const deleteCheckedMessages = () => {
    if (!active || !selectedChatId || !checkedMessages.length) return;
    const removed = messages.filter((message) => checkedMessages.includes(message.id));
    mutate((draft) => {
      const thread = draft.messages[active.id]?.[selectedChatId];
      if (!thread) return;
      draft.messages[active.id][selectedChatId] = thread.filter((message) => !checkedMessages.includes(message.id));
    });
    broadcastDeletions(removed);
    const authored = removed.filter((message) => message.senderId === active.id && message.kind !== "deletion-log").length;
    setCheckedMessages([]);
    setSelectionMode(false);
    notify(authored ? `${removed.length} deleted · ${authored} deletion log${authored === 1 ? "" : "s"} sent` : `${removed.length} entr${removed.length === 1 ? "y" : "ies"} deleted here`);
  };

  const deleteSingleMessage = (message: ChatMessage) => {
    if (!active || !selectedChatId) return;
    mutate((draft) => {
      const thread = draft.messages[active.id]?.[selectedChatId];
      if (!thread) return;
      draft.messages[active.id][selectedChatId] = thread.filter((item) => item.id !== message.id);
    });
    broadcastDeletions([message]);
    notify(message.kind === "deletion-log" ? "Deletion log removed" : "Message deleted");
  };

  const clearMyHistory = () => {
    if (!active || !selectedChatId) return;
    const removed = messages.slice();
    mutate((draft) => {
      if (draft.messages[active.id]) delete draft.messages[active.id][selectedChatId];
    });
    broadcastDeletions(removed);
    forgetChatMeta(active.id, selectedChatId);
    setModal(null);
    setSelectionMode(false);
    setCheckedMessages([]);
    notify("Your local history was deleted.");
  };

  const requestPurge = () => {
    if (!active || !selectedFriend) return;
    const conn = connectionsRef.current.get(selectedFriend.peerId);
    if (!conn?.open) {
      notify("Both people must be online to erase everything.");
      return;
    }
    conn.send({ type: "purge-request", requestId: uid(), senderId: active.id } satisfies Packet);
    setModal(null);
    notify("Erase request sent. Your friend must agree.");
  };

  const answerPurge = (accept: boolean) => {
    if (!active || !incomingPurge) return;
    const friend = friends.find((item) => item.id === incomingPurge.friendId);
    const conn = friend ? connectionsRef.current.get(friend.peerId) : undefined;
    if (!friend || !conn?.open) {
      notify("Your friend must be online to finish this request.");
      setIncomingPurge(null);
      return;
    }
    conn.send({
      type: accept ? "purge-confirm" : "purge-reject",
      requestId: incomingPurge.requestId,
      senderId: active.id,
    } as Packet);
    if (accept) {
      mutate((draft) => {
        if (draft.messages[active.id]) delete draft.messages[active.id][friend.id];
      });
      forgetChatMeta(active.id, friend.id);
    }
    setIncomingPurge(null);
    notify(accept ? "All conversation data was erased for both sides." : "The conversation was kept.");
  };

  const blockFriend = () => {
    if (!active || !selectedFriend) return;
    const conn = connectionsRef.current.get(selectedFriend.peerId);
    if (conn?.open) conn.send({ type: "friend-block", senderId: active.id } satisfies Packet);
    mutate((draft) => {
      const friend = (draft.friends[active.id] ?? []).find((item) => item.id === selectedFriend.id);
      if (friend) friend.relation = "blocked";
    });
    window.setTimeout(() => conn?.close(), 80);
    setModal(null);
    notify("Connection blocked. You can restore it without a new number.");
  };

  const unblockFriend = () => {
    if (!active || !selectedFriend) return;
    const peerId = selectedFriend.peerId;
    mutate((draft) => {
      const friend = (draft.friends[active.id] ?? []).find((item) => item.id === selectedFriend.id);
      if (friend) friend.relation = "active";
    });
    forceDialRef.current.add(peerId);
    const conn = connectToRef.current?.(peerId);
    if (conn?.open) {
      conn.send({ type: "friend-unblock", senderId: active.id } satisfies Packet);
      forceDialRef.current.delete(peerId);
    } else {
      conn?.on("open", () => {
        conn.send({ type: "friend-unblock", senderId: active.id } satisfies Packet);
        forceDialRef.current.delete(peerId);
      });
    }
    setModal(null);
    notify("Connection restored.");
  };

  const requestDeleteFriend = () => {
    if (!active || !selectedFriend) return;
    const requestedAt = Date.now();
    const requestId = uid();
    const conn = connectionsRef.current.get(selectedFriend.peerId);
    if (conn?.open) {
      conn.send({ type: "delete-request", requestId, senderId: active.id } satisfies Packet);
    }
    mutate((draft) => {
      const friend = (draft.friends[active.id] ?? []).find((item) => item.id === selectedFriend.id);
      if (friend) friend.deleteRequest = { id: requestId, direction: "out", requestedAt };
    });
    setModal(null);
    notify(conn?.open ? "Delete request sent. Your friend must approve it." : "Delete request saved. If friend remains offline for 1 month, you can finalize removal.");
  };

  /**
   * Finalize removal when friend has not gone online even once for 1 month
   * after the deletion request was submitted. Unilateral, no consent needed.
   */
  const finalizeTimedOutRemoval = (friend: Friend) => {
    if (!active) return;
    const name = friend.nickname;
    queueControl(active.id, friend, "friend-removed", { at: Date.now() });
    removeFriendLocally(active.id, friend.id);
    notify(`${name} was removed after remaining offline for 1 month following your deletion request.`);
  };

  const answerDeleteRequest = (accept: boolean) => {
    if (!active || !incomingDelete) return;
    const friend = friends.find((item) => item.id === incomingDelete.friendId);
    const conn = friend ? connectionsRef.current.get(friend.peerId) : undefined;
    if (!friend || !conn?.open) {
      notify("Your friend must be online to finish this request.");
      return;
    }
    conn.send({ type: accept ? "delete-confirm" : "delete-reject", requestId: incomingDelete.requestId, senderId: active.id } as Packet);
    if (accept) removeFriendLocally(active.id, friend.id);
    else mutate((draft) => {
      const target = (draft.friends[active.id] ?? []).find((item) => item.id === friend.id);
      if (target) delete target.deleteRequest;
    });
    setIncomingDelete(null);
    notify(accept ? "The connection was permanently deleted." : "The connection was kept.");
  };

  const createGroup = (name: string, memberIds: string[]) => {
    if (!active) return;
    const members: Profile[] = [
      active,
      ...friends
        .filter((friend) => memberIds.includes(friend.id))
        .map(({ id, peerId, nickname, bio, color, createdAt, avatarImage }) => ({ id, peerId, nickname, bio, color, createdAt, avatarImage })),
    ];
    const group: Group = { id: uid(), name, creatorId: active.id, members, createdAt: Date.now() };
    mutate((draft) => {
      ensureOwnerBuckets(draft, active.id);
      draft.groups[active.id].push(group);
    });
    friends.filter((friend) => memberIds.includes(friend.id)).forEach((friend) => queueControl(active.id, friend, "group-sync", group));
    setModal(null);
    setSection("groups");
    setSelected(`group:${group.id}`);
    setMobileChat(true);
  };

  const addGroupMembers = (memberIds: string[]) => {
    if (!active || !selectedGroup || selectedGroup.creatorId !== active.id) return;
    const additions = friends.filter((friend) => memberIds.includes(friend.id));
    const updated: Group = {
      ...selectedGroup,
      members: [
        ...selectedGroup.members,
        ...additions
          .filter((friend) => !selectedGroup.members.some((member) => member.id === friend.id))
          .map(({ id, peerId, nickname, bio, color, createdAt, avatarImage }) => ({ id, peerId, nickname, bio, color, createdAt, avatarImage })),
      ],
    };
    upsertIncomingGroup(active.id, updated);
    updated.members.filter((member) => member.id !== active.id).forEach((member) => {
      const friend = friends.find((item) => item.id === member.id);
      if (friend) queueControl(active.id, friend, "group-sync", updated);
    });
  };

  const deleteOrLeaveGroup = (action: "delete" | "leave") => {
    if (!active || !selectedGroup) return;
    const groupId = selectedGroup.id;
    if (action === "delete" && selectedGroup.creatorId === active.id) {
      selectedGroup.members.filter((member) => member.id !== active.id).forEach((member) => {
        const friend = friends.find((item) => item.id === member.id);
        if (friend) queueControl(active.id, friend, "group-delete", groupId);
      });
    } else if (selectedGroup.creatorId === active.id) {
      const remaining = selectedGroup.members.filter((member) => member.id !== active.id);
      const updated: Group = { ...selectedGroup, creatorId: remaining[0]?.id ?? "", members: remaining };
      remaining.forEach((member) => {
        const friend = friends.find((item) => item.id === member.id);
        if (friend) queueControl(active.id, friend, "group-sync", updated);
      });
    } else {
      const creator = friends.find((friend) => friend.id === selectedGroup.creatorId);
      if (creator) queueControl(active.id, creator, "group-leave", groupId);
    }
    mutate((draft) => {
      draft.groups[active.id] = (draft.groups[active.id] ?? []).filter((group) => group.id !== groupId);
      if (draft.messages[active.id]) delete draft.messages[active.id][groupId];
      draft.groupDeletions[active.id] = (draft.groupDeletions[active.id] ?? []).filter((job) => job.groupId !== groupId);
    });
    forgetChatMeta(active.id, groupId);
    setSelected("");
    setMobileChat(false);
    setModal(null);
  };

  const toggleChecked = (id: string) => {
    setCheckedMessages((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const onScrollMessages = () => {
    const node = messageScrollRef.current;
    if (!node) return;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 80);
  };

  const query = search.trim().toLowerCase();
  const messageMatches = useMemo(() => {
    if (!query || !active) return {} as Record<string, number>;
    const out: Record<string, number> = {};
    Object.entries(data.messages[active.id] ?? {}).forEach(([chatId, list]) => {
      const count = list.filter((message) => message.kind !== "deletion-log" && message.text.toLowerCase().includes(query)).length;
      if (count) out[chatId] = count;
    });
    return out;
  }, [query, data.messages, active]);

  const filteredFriends = useMemo(
    () => friends.filter((friend) =>
      !query
      || `${friend.nickname} ${friend.bio}`.toLowerCase().includes(query)
      || (messageMatches[friend.id] ?? 0) > 0
    ),
    [friends, query, messageMatches]
  );
  const filteredGroups = useMemo(
    () => groups.filter((group) =>
      !query
      || group.name.toLowerCase().includes(query)
      || (messageMatches[group.id] ?? 0) > 0
    ),
    [groups, query, messageMatches]
  );
  const onlineFriendCount = friends.filter((friend) => friend.relation === "active" && onlinePeers.has(friend.peerId)).length;

  /* --------------------------------- render ------------------------------- */

  if (!active && data.accounts.length === 0) {
    return (
      <>
        <Onboarding
          onCreate={createFirstAccount}
          theme={theme}
          onTheme={setTheme}
          onTransfer={() => setModal("transfer-receive")}
        />
        <AnimatePresence>
          {modal === "transfer-receive" && (
            <TransferDialog
              mode="receive"
              snapshot={transferSnapshot}
              onClose={() => setModal(null)}
              onReceive={applyTransfer}
              onCopy={handleCopy}
              onEraseAfterSend={eraseDevice}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {toast && <motion.div className="toast" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}><CheckCircle2 size={17} />{toast}</motion.div>}
        </AnimatePresence>
      </>
    );
  }
  if (!active) return null;

  const peerOnline = selectedFriend ? onlinePeers.has(selectedFriend.peerId) && selectedFriend.relation === "active" : false;
  const peerIsAway = peerOnline && selectedFriend ? peerHidden[selectedFriend.peerId] === true : false;
  const groupOnlineCount = selectedGroup?.members.filter((member) => member.id === active.id || onlinePeers.has(member.peerId)).length ?? 0;
  const conversationName = selectedFriend?.nickname ?? selectedGroup?.name ?? "";
  const conversationProfile = selectedFriend ?? (selectedGroup ? { nickname: selectedGroup.name, color: "#171A21" } : null);
  const chatLimit = selectedGroup ? selectedGroup.members.length * GROUP_PER_MEMBER : DIRECT_LIMIT;
  const composerLocked = Boolean(selectedFriend && selectedFriend.relation !== "active");
  const theirReceipt = selectedFriend ? data.receipts[active.id]?.[selectedFriend.id] ?? 0 : 0;

  const typingNow = Object.entries(typing).filter(([, info]) => info.chatId === selectedChatId && Date.now() - info.at <= 4000);
  const typingLabel = typingNow.length
    ? selectedGroup
      ? `${typingNow.map(([accountId]) => selectedGroup.members.find((member) => member.id === accountId)?.nickname ?? "Someone").join(", ")} typing…`
      : "typing…"
    : "";

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileChat ? "mobile-hidden" : ""}`}>
        <div className="sidebar-topbar">
          <BrandMark compact />
          <div className="topbar-actions">
            <div className="network-badge" title={`Network: ${networkState}`}>
              <span className={`network-dot ${networkState}`} />
              <span>{networkState === "online" ? `${onlineFriendCount} online` : networkState}</span>
            </div>
            <button className="icon-button" onClick={() => setModal("settings")} aria-label="Settings"><Settings size={18} /></button>
          </div>
        </div>

        <div className="identity-strip">
          <button className="identity-button" onClick={() => setAccountMenu((open) => !open)}>
            <Avatar profile={active} customImage={active.avatarImage} size="md" />
            <span><strong>{active.nickname}</strong><small>{active.bio || "No profile yet"}</small></span>
            <ChevronDown size={17} />
          </button>
          <button className="icon-button prominent" onClick={() => setModal("add")} aria-label="Add a friend"><UserPlus size={19} /></button>
          <AnimatePresence>
            {accountMenu && (
              <motion.div className="account-menu" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                <p className="menu-label">Switch identity</p>
                {data.accounts.map((account) => (
                  <button key={account.id} className={account.id === active.id ? "account-option active" : "account-option"} onClick={() => setActiveId(account.id)}>
                    <Avatar profile={account} customImage={account.avatarImage} size="sm" /><span>{account.nickname}</span>{account.id === active.id && <Check size={15} />}
                  </button>
                ))}
                <div className="menu-divider" />
                <button onClick={() => { setModal("edit-profile"); setAccountMenu(false); }}><Pencil size={16} /> Edit profile</button>
                <button disabled={data.accounts.length >= 5} onClick={() => { setModal("account"); setAccountMenu(false); }}><Plus size={16} /> New identity <small>{data.accounts.length}/5</small></button>
                <button disabled={totalUnread === 0} onClick={() => { markAllRead(); setAccountMenu(false); }}><CheckCheck size={16} /> Mark all as read {totalUnread > 0 && <small>{totalUnread}</small>}</button>
                <button onClick={() => { setModal("settings"); setAccountMenu(false); }}><Settings size={16} /> Settings</button>
                <button onClick={() => { setModal("about"); setAccountMenu(false); }}><Info size={16} /> How Chasy P works</button>
                <button className="danger-text" onClick={() => { setModal("delete-account"); setAccountMenu(false); }}><Trash2 size={16} /> Delete this identity</button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="sidebar-tools">
          <div className="search-box">
            <Search size={17} />
            <input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people or messages ( / )" />
            {search && <button className="icon-button tiny" onClick={() => setSearch("")} aria-label="Clear search"><X size={14} /></button>}
          </div>
          <div className="list-tabs">
            <button className={section === "friends" ? "active" : ""} onClick={() => setSection("friends")}><MessageCircle size={16} /> Friends <span>{friends.length}</span></button>
            <button className={section === "groups" ? "active" : ""} onClick={() => setSection("groups")}><Users size={16} /> Groups <span>{groups.length}</span></button>
          </div>
        </div>

        <div className="conversation-list" aria-label={section === "friends" ? "Friend list" : "Group list"}>
          {section === "friends" && filteredFriends.map((friend) => {
            const isOnline = onlinePeers.has(friend.peerId) && friend.relation === "active";
            const isAway = isOnline && peerHidden[friend.peerId] === true;
            const isActiveOnline = isOnline && !isAway;
            const last = data.messages[active.id]?.[friend.id]?.at(-1);
            const unread = unreadCounts[friend.id] ?? 0;
            const hits = messageMatches[friend.id] ?? 0;
            const hasTimedOutRemoval = timedOutRemovalFriends.some((item) => item.id === friend.id);
            const preview = friend.relation === "blocked"
              ? "Blocked · tap to restore"
              : friend.relation === "blockedByThem"
                ? "Connection paused by friend"
                : last
                  ? last.kind === "deletion-log"
                    ? "Message deleted"
                    : `${last.senderId === active.id ? "You: " : ""}${last.kind === "sticker" ? "Sticker" : last.text}`
                  : friend.bio || (isActiveOnline ? "Online now" : isAway ? "Away (other tab)" : "Offline");
            return (
              <button key={friend.id} className={selected === `friend:${friend.id}` ? "conversation-row active" : "conversation-row"} onClick={() => { setSelected(`friend:${friend.id}`); setMobileChat(true); }}>
                <div className="avatar-status">
                  <Avatar
                    profile={friend}
                    customImage={showFriendIcons ? ephemeralAvatars[friend.id] : undefined}
                    size="md"
                    preventSave={true}
                  />
                  <span
                    className={
                      isActiveOnline
                        ? "presence online"
                        : isAway
                          ? "presence away"
                          : "presence"
                    }
                    title={
                      isActiveOnline
                        ? "Online · active now"
                        : isAway
                          ? "Away · another page or app is open"
                          : `Offline · last reached ${formatLastSeen(lastSeenOf(friend.id, friend.addedAt))}`
                    }
                  >
                    {!isOnline && <WifiOff size={8} />}
                    {isAway && <EyeOff size={7} />}
                  </span>
                </div>
                <span className="row-content">
                  <span className="row-title"><strong>{friend.nickname}</strong><span className="row-meta"><time>{last ? formatListTime(last.sentAt) : ""}</time>{unread > 0 && <span className="unread-badge">{unread}</span>}</span></span>
                  <span className="row-preview">{preview}</span>
                  <span className="row-chips">
                    {hasTimedOutRemoval && <span className="stale-chip"><Clock size={9} /> 30d+ offline</span>}
                    {query && hits > 0 && <span className="match-chip">{hits} message{hits === 1 ? "" : "s"} match</span>}
                  </span>
                </span>
                {last?.status === "queued" && <span className="queue-mark" title="Queued" />}
              </button>
            );
          })}
          {section === "groups" && filteredGroups.map((group) => {
            const last = data.messages[active.id]?.[group.id]?.at(-1);
            const countOnline = group.members.filter((member) => member.id === active.id || onlinePeers.has(member.peerId)).length;
            const unread = unreadCounts[group.id] ?? 0;
            const hits = messageMatches[group.id] ?? 0;
            return (
              <button key={group.id} className={selected === `group:${group.id}` ? "conversation-row active" : "conversation-row"} onClick={() => { setSelected(`group:${group.id}`); setMobileChat(true); }}>
                <div className="group-avatar"><Users size={18} /></div>
                <span className="row-content">
                  <span className="row-title"><strong>{group.name}</strong><span className="row-meta"><time>{last ? formatListTime(last.sentAt) : ""}</time>{unread > 0 && <span className="unread-badge">{unread}</span>}</span></span>
                  <span className="row-preview">{last ? (last.kind === "deletion-log" ? `${last.senderName} deleted a message` : `${last.senderId === active.id ? "You" : last.senderName}: ${last.kind === "sticker" ? "Sticker" : last.text}`) : `${countOnline}/${group.members.length} online`}</span>
                  {query && hits > 0 && <span className="match-chip">{hits} message{hits === 1 ? "" : "s"} match</span>}
                </span>
                {last?.status === "queued" && <span className="queue-mark" />}
              </button>
            );
          })}
          {((section === "friends" && filteredFriends.length === 0) || (section === "groups" && filteredGroups.length === 0)) && (
            <div className="empty-list">
              {section === "friends" ? <UserPlus size={24} /> : <Users size={24} />}
              <strong>{query ? "Nothing found" : section === "friends" ? "Your list starts here" : "No groups yet"}</strong>
              <p>{query ? "Try another search." : section === "friends" ? "Exchange a temporary number to add someone." : "Create a group from people who are already friends."}</p>
              {!query && <button className="text-button" onClick={() => setModal(section === "friends" ? "add" : "group")}><Plus size={15} /> {section === "friends" ? "Add a friend" : "Create a group"}</button>}
            </div>
          )}
        </div>
        <AnimatePresence>
          {timedOutRemovalFriends.length > 0 && (
            <motion.button
              className="timed-out-strip"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              onClick={() => setModal("timed-out-deletions")}
            >
              <Clock size={15} />
              <span><strong>{timedOutRemovalFriends.length} deletion request{timedOutRemovalFriends.length === 1 ? "" : "s"} timed out</strong><small>Friend remained offline for 1 month · Tap to finalize</small></span>
              <ChevronDown size={15} className="strip-arrow" />
            </motion.button>
          )}
        </AnimatePresence>
        <button className="new-group-button" onClick={() => setModal("group")}><Plus size={17} /> New group</button>
      </aside>

      <section className={`chat-pane ${mobileChat ? "mobile-visible" : ""}`}>
        {!selectedFriend && !selectedGroup ? (
          <div className="empty-conversation">
            <motion.div className="empty-signal" animate={{ scale: [1, 1.04, 1] }} transition={{ duration: 3.8, repeat: Infinity }}><MessageCircle size={37} /></motion.div>
            <p className="overline">Your private space</p>
            <h2>Choose a conversation.</h2>
            <p>Messages are saved only on this device. Direct chats keep {DIRECT_LIMIT} entries, groups keep members × {GROUP_PER_MEMBER}. Drafts save automatically.</p>
            <button className="secondary-button desktop-empty-action" onClick={() => setModal("add")}><UserPlus size={17} /> Add someone</button>
            <p className="shortcut-hint">Press <kbd>/</kbd> or <kbd>⌘K</kbd> to search · <kbd>Esc</kbd> closes panels</p>
          </div>
        ) : (
          <>
            {selectionMode ? (
              <header className="chat-header selection-header">
                <button className="icon-button" onClick={() => { setSelectionMode(false); setCheckedMessages([]); }} aria-label="Cancel selection"><X size={20} /></button>
                <div className="chat-heading">
                  <h1>{checkedMessages.length} selected</h1>
                  <p>Your own messages leave a deletion log for the other side.</p>
                </div>
                <button className="text-button" onClick={() => setCheckedMessages(messages.map((message) => message.id))}>All</button>
                <button className="icon-button danger-icon" disabled={!checkedMessages.length} onClick={deleteCheckedMessages} aria-label="Delete selected"><Trash2 size={19} /></button>
              </header>
            ) : (
              <header className="chat-header">
                <button className="icon-button mobile-back" onClick={() => setMobileChat(false)} aria-label="Back to list"><ArrowLeft size={20} /></button>
                {conversationProfile && (selectedFriend ? (
                  <Avatar
                    profile={conversationProfile}
                    customImage={showFriendIcons ? ephemeralAvatars[selectedFriend.id] : undefined}
                    size="md"
                    preventSave={true}
                  />
                ) : (
                  <div className="group-avatar header-group"><Users size={18} /></div>
                ))}
                <div className="chat-heading">
                  <h1>{conversationName}</h1>
                  {typingLabel ? (
                    <p className="typing-copy"><span className="typing-dots"><i /><i /><i /></span>{typingLabel}</p>
                  ) : selectedFriend ? (
                    <p
                      className={
                        peerOnline
                          ? peerIsAway
                            ? "away-copy"
                            : "online-copy"
                          : ""
                      }
                    >
                      {selectedFriend.relation === "blocked" ? (
                        "Blocked by you"
                      ) : selectedFriend.relation === "blockedByThem" ? (
                        "Connection paused"
                      ) : peerOnline ? (
                        peerIsAway ? (
                          <><EyeOff size={12} /> Away · in another tab or page</>
                        ) : (
                          <><Wifi size={12} /> Online · active now</>
                        )
                      ) : (
                        <><WifiOff size={12} /> Last seen {formatLastSeen(lastSeenOf(selectedFriend.id, selectedFriend.addedAt))} · messages will queue</>
                      )}
                    </p>
                  ) : (
                    <p>{groupOnlineCount} of {selectedGroup?.members.length} online</p>
                  )}
                </div>
                <button className="icon-button" disabled={!messages.length} onClick={() => setSelectionMode(true)} aria-label="Select messages"><ListChecks size={19} /></button>
                <button className="icon-button" onClick={() => setModal(selectedFriend ? "friend-actions" : "group-info")} aria-label="Conversation options"><Ellipsis size={21} /></button>
              </header>
            )}

            <div className="message-scroll" ref={messageScrollRef} onScroll={onScrollMessages}>
              {messages.length === 0 && (
                <div className="conversation-intro">
                  {conversationProfile && (selectedFriend ? (
                    <Avatar
                      profile={conversationProfile}
                      customImage={showFriendIcons ? ephemeralAvatars[selectedFriend.id] : undefined}
                      size="xl"
                      preventSave={true}
                    />
                  ) : (
                    <div className="group-avatar intro-group"><Users size={26} /></div>
                  ))}
                  <h2>{conversationName}</h2>
                  <p>{selectedFriend ? selectedFriend.bio || "This is the beginning of your direct conversation." : `${selectedGroup?.members.length} people share this local-first group.`}</p>
                  <span><LockKeyhole size={13} /> Messages travel over an encrypted WebRTC data channel.</span>
                </div>
              )}

              {messages.length >= chatLimit - 5 && messages.length > 0 && (
                <div className="retention-note"><Info size={12} /> Keeping the newest {chatLimit} entries — older ones are removed automatically.</div>
              )}

              {messages.map((message, index) => {
                const mine = message.senderId === active.id;
                const previous = messages[index - 1];
                const showDate = !previous || new Date(previous.sentAt).toDateString() !== new Date(message.sentAt).toDateString();
                const checked = checkedMessages.includes(message.id);

                if (message.kind === "deletion-log") {
                  return (
                    <div key={message.id}>
                      {showDate && <div className="date-divider"><span>{formatDateDivider(message.sentAt)}</span></div>}
                      <motion.div
                        className={`deletion-log ${checked ? "checked" : ""} ${selectionMode ? "selectable" : ""}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        onClick={() => selectionMode && toggleChecked(message.id)}
                      >
                        {selectionMode && <span className="log-check">{checked && <Check size={12} />}</span>}
                        <Ban size={12} />
                        <span>{mine ? "You" : message.senderName} deleted a message</span>
                        <time>{formatTime(message.sentAt)}</time>
                        {!selectionMode && (
                          <button className="log-remove" onClick={(event) => { event.stopPropagation(); deleteSingleMessage(message); }} aria-label="Remove this deletion log"><X size={11} /></button>
                        )}
                      </motion.div>
                    </div>
                  );
                }

                const showSender = !!selectedGroup && !mine && (!previous || previous.senderId !== message.senderId || showDate);
                const readByThem = mine && selectedFriend && message.status === "sent" && theirReceipt >= message.sentAt;
                return (
                  <div key={message.id}>
                    {showDate && <div className="date-divider"><span>{formatDateDivider(message.sentAt)}</span></div>}
                    <motion.div
                      className={`message-line ${mine ? "mine" : ""} ${selectionMode ? "selectable" : ""} ${checked ? "checked" : ""}`}
                      initial={{ opacity: 0, y: 7 }}
                      animate={{ opacity: 1, y: 0 }}
                      onClick={() => selectionMode && toggleChecked(message.id)}
                    >
                      {selectionMode && <span className="bubble-check">{checked && <Check size={13} />}</span>}
                      <div
                        className={message.kind === "sticker" ? "message-bubble sticker" : "message-bubble"}
                        onDoubleClick={() => !selectionMode && handleCopy(message.text, "Message copied")}
                        title={selectionMode ? undefined : "Double-click to copy"}
                      >
                        {showSender && <small className="sender-name">{message.senderName}</small>}
                        {message.kind === "text" ? (
                          <MessageText text={message.text} linksEnabled={linksEnabled && !selectionMode} />
                        ) : (
                          <span>{message.text}</span>
                        )}
                        <small className="message-meta">
                          {formatTime(message.sentAt)}
                          {mine && message.status === "queued" && <><span>·</span><WifiOff size={10} /> queued</>}
                          {readByThem && <CheckCheck size={11} aria-label="Read" />}
                          {!selectionMode && (
                            <button className="copy-msg-btn" onClick={(event) => { event.stopPropagation(); handleCopy(message.text, "Message copied"); }} aria-label="Copy message"><Copy size={10} /></button>
                          )}
                        </small>
                      </div>
                    </motion.div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <AnimatePresence>
              {!atBottom && (
                <motion.button
                  className="scroll-bottom"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  onClick={() => { setAtBottom(true); messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }}
                  aria-label="Jump to latest"
                >
                  <ArrowDown size={17} />
                  {(unreadCounts[selectedChatId] ?? 0) > 0 && <span className="scroll-bottom-count">{unreadCounts[selectedChatId]}</span>}
                </motion.button>
              )}
            </AnimatePresence>

            <form className="composer" onSubmit={submitMessage}>
              <AnimatePresence>
                {showEmoji && (
                  <EmojiPicker
                    onClose={() => setShowEmoji(false)}
                    onInsert={(emoji) => { updateDraft((messageText + emoji).slice(0, messageLimit)); sendTypingSignal(); }}
                    onSendSticker={(emoji) => sendMessage(emoji, "sticker")}
                  />
                )}
              </AnimatePresence>
              <button type="button" className="icon-button composer-icon" onClick={() => setShowEmoji((open) => !open)} aria-label="Open emoji picker"><Smile size={21} /></button>
              <div className="composer-field">
                <input
                  value={messageText}
                  onChange={(event) => { updateDraft(event.target.value.slice(0, messageLimit)); sendTypingSignal(); }}
                  placeholder={composerLocked ? "This connection is paused" : selectedFriend && !peerOnline ? "Type now, send when both are online" : "Write a message"}
                  disabled={composerLocked}
                />
                <span className={messageText.length >= messageLimit ? "at-limit" : ""}>{messageText.length}/{messageLimit}</span>
              </div>
              <button className="send-button" disabled={!messageText.trim() || composerLocked} aria-label="Send message"><Send size={18} /></button>
            </form>
          </>
        )}
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) handleImportFile(file);
          event.currentTarget.value = "";
        }}
      />

      <AnimatePresence>
        {modal === "add" && <AddFriendDialog onClose={closeAddDialog} inviteCode={inviteCode} inviteStatus={inviteStatus} onGenerate={generateInvite} onJoin={joinInvite} onCopy={handleCopy} />}
        {modal === "account" && <CreateAccountDialog accounts={data.accounts} onClose={() => setModal(null)} onCreate={createAdditionalAccount} />}
        {modal === "edit-profile" && <EditProfileDialog account={active} accounts={data.accounts} onClose={() => setModal(null)} onSave={saveProfile} />}
        {modal === "group" && <GroupDialog active={active} friends={friends} onClose={() => setModal(null)} onCreate={createGroup} />}
        {modal === "settings" && (
          <SettingsDialog
            theme={theme}
            onTheme={setTheme}
            linksEnabled={linksEnabled}
            onLinksEnabled={setLinksEnabled}
            showFriendIcons={showFriendIcons}
            onShowFriendIcons={setShowFriendIcons}
            longMessages={longMessages}
            onLongMessages={setLongMessages}
            storageBytes={storageBytes}
            pendingOutbox={data.outbox.filter((item) => item.ownerId === active.id).length}
            pendingGroupNotices={(data.groupDeletions[active.id] ?? []).length}
            pendingNotices={pendingNotices}
            deliveredNotices={deliveredNotices}
            noticeState={noticeState}
            friendCount={friends.length}
            connectedCount={onlineFriendCount}
            networkState={networkState}
            onNotifyNow={() => { setNotifyTick((n) => n + 1); notify("Checking for former friends now…"); }}
            onClose={() => setModal(null)}
            onExport={exportData}
            onImport={() => setModal("import")}
            onTransfer={() => setModal("transfer-send")}
            onEraseDevice={() => setModal("erase-device")}
          />
        )}
        {modal === "timed-out-deletions" && (
          <TimedOutDeletionsDialog
            timedOutFriends={timedOutRemovalFriends}
            seenAt={lastSeenOf}
            onClose={() => setModal(null)}
            onFinalize={(friend) => {
              finalizeTimedOutRemoval(friend);
              if (timedOutRemovalFriends.length <= 1) setModal(null);
            }}
          />
        )}
        {(modal === "transfer-send" || modal === "transfer-receive") && (
          <TransferDialog
            mode={modal === "transfer-send" ? "send" : "receive"}
            snapshot={transferSnapshot}
            onClose={() => setModal(null)}
            onReceive={applyTransfer}
            onCopy={handleCopy}
            onEraseAfterSend={eraseDevice}
          />
        )}
        {modal === "delete-account" && (
          <Modal onClose={() => setModal(null)} className="small-modal" labelledBy="modal-title">
            <div className="danger-symbol"><Trash2 size={22} /></div>
            <h2 id="modal-title">Delete {active.nickname}?</h2>
            <p className="modal-copy">This permanently removes this identity, its local messages, and groups. Other identities on this device stay intact. Friends are told when they next connect — keep this tab open until then if you can.</p>
            <div className="modal-actions vertical-mobile"><button className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="danger-button" onClick={deleteActiveAccount}>Delete identity</button></div>
          </Modal>
        )}
        {modal === "erase-device" && (
          <Modal onClose={() => setModal(null)} className="small-modal" labelledBy="modal-title">
            <div className="danger-symbol"><Eraser size={22} /></div>
            <h2 id="modal-title">Erase everything here?</h2>
            <p className="modal-copy">Every identity, friend, group, message, and draft stored in this browser will be removed. Friends keep their own copies. This cannot be undone — export a backup first if you are unsure.</p>
            <div className="modal-actions vertical-mobile"><button className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="danger-button" onClick={eraseDevice}>Erase this device</button></div>
          </Modal>
        )}
        {modal === "clear-history" && (
          <Modal onClose={() => setModal(null)} className="small-modal" labelledBy="modal-title">
            <div className="danger-symbol warning-symbol"><Eraser size={22} /></div>
            <h2 id="modal-title">Delete your history here?</h2>
            <p className="modal-copy">Every entry in <strong>{conversationName}</strong> disappears from this device. Messages you sent become “deleted a message” logs on the other side; their own messages are untouched.</p>
            <div className="modal-actions vertical-mobile"><button className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="danger-button" onClick={clearMyHistory}>Delete my history</button></div>
          </Modal>
        )}
        {modal === "purge-request" && (
          <Modal onClose={() => setModal(null)} className="small-modal" labelledBy="modal-title">
            <div className="danger-symbol warning-symbol"><AlertTriangle size={22} /></div>
            <h2 id="modal-title">Erase all conversation data?</h2>
            <p className="modal-copy">This asks {conversationName} to erase the whole conversation — messages and deletion logs — on both devices at once. It only happens if they agree.</p>
            <div className="modal-actions vertical-mobile"><button className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="danger-button" onClick={requestPurge}>Send erase request</button></div>
          </Modal>
        )}
        {modal === "friend-actions" && selectedFriend && (
          <Modal onClose={() => setModal(null)} className="medium-modal" labelledBy="modal-title">
            <ModalHeader title={selectedFriend.nickname} subtitle={selectedFriend.bio || "Direct connection"} onClose={() => setModal(null)} />
            <div className="seen-strip">
              <span className={peerOnline ? (peerIsAway ? "dot away" : "dot live") : "dot"} />
              {peerOnline
                ? (peerIsAway ? "Connected · another page or app open" : "Connected and active right now")
                : `Last reached ${formatLastSeen(lastSeenOf(selectedFriend.id, selectedFriend.addedAt))}`}
              {timedOutRemovalFriends.some((item) => item.id === selectedFriend.id) && <em>· 30+ days offline since request</em>}
            </div>
            <div className="action-list">
              {selectedFriend.deleteRequest?.direction === "in" && (
                <button onClick={() => { setIncomingDelete({ friendId: selectedFriend.id, requestId: selectedFriend.deleteRequest!.id }); setModal(null); }}><AlertTriangle size={18} /><span><strong>Review delete request</strong><small>Your friend is waiting for your decision.</small></span></button>
              )}
              <button disabled={!messages.length} onClick={() => { setModal(null); setSelectionMode(true); }}><ListChecks size={18} /><span><strong>Select messages</strong><small>Pick individual entries to delete.</small></span></button>
              <button disabled={!messages.length} onClick={() => { exportConversation(); setModal(null); }}><Download size={18} /><span><strong>Export conversation</strong><small>Save this chat as a text file.</small></span></button>
              <button disabled={!messages.length} onClick={() => setModal("clear-history")}><Eraser size={18} /><span><strong>Delete my history</strong><small>Clears this device and sends deletion logs.</small></span></button>
              <button disabled={!peerOnline} onClick={() => setModal("purge-request")}><Database size={18} /><span><strong>Erase for both</strong><small>{peerOnline ? "Needs your friend's agreement." : "Both people must be online."}</small></span></button>
              <div className="menu-divider" />
              {selectedFriend.relation === "blocked" ? (
                <button onClick={unblockFriend}><Shield size={18} /><span><strong>Restore connection</strong><small>No new connection number is needed.</small></span></button>
              ) : (
                <button onClick={blockFriend}><ShieldOff size={18} /><span><strong>Block</strong><small>Unilaterally pause this connection.</small></span></button>
              )}
              <button className="danger-text" onClick={requestDeleteFriend} disabled={selectedFriend.relation !== "active" || !!selectedFriend.deleteRequest}><Trash2 size={18} /><span><strong>{selectedFriend.deleteRequest?.direction === "out" ? "Delete request pending" : "Delete permanently"}</strong><small>Requires approval from both people.</small></span></button>
              {timedOutRemovalFriends.some((item) => item.id === selectedFriend.id) && (
                <button className="danger-text" onClick={() => { finalizeTimedOutRemoval(selectedFriend); setModal(null); }}><UserX size={18} /><span><strong>Finalize deletion (offline 30+ days)</strong><small>Friend remained offline for 1 month since request — no consent needed.</small></span></button>
              )}
            </div>
          </Modal>
        )}
        {modal === "group-info" && selectedGroup && (
          <GroupInfoDialog
            group={selectedGroup}
            active={active}
            friends={friends}
            ephemeralAvatars={ephemeralAvatars}
            showFriendIcons={showFriendIcons}
            hasMessages={messages.length > 0}
            onClose={() => setModal(null)}
            onAdd={addGroupMembers}
            onDelete={() => deleteOrLeaveGroup("delete")}
            onLeave={() => deleteOrLeaveGroup("leave")}
            onClearHistory={() => setModal("clear-history")}
            onSelectMessages={() => { setModal(null); setSelectionMode(true); }}
            onExport={() => { exportConversation(); setModal(null); }}
          />
        )}
        {modal === "import" && (
          <Modal onClose={() => setModal(null)} className="medium-modal" labelledBy="modal-title">
            <ModalHeader title="Import backup" subtitle="Restore a previously exported JSON file. This replaces current local data." onClose={() => setModal(null)} />
            <div className="import-area">
              <button className="secondary-button wide" onClick={() => fileInputRef.current?.click()}><FileUp size={16} /> Choose JSON file</button>
              <p className="small-label centered-label">Or paste JSON</p>
              <textarea className="import-textarea" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder='{"version":1,"accounts":[...]}' rows={6} />
              <button className="primary-button wide" disabled={!importText.trim()} onClick={() => applyImport(importText)}>Import from text</button>
            </div>
          </Modal>
        )}
        {modal === "about" && (
          <Modal onClose={() => setModal(null)} className="medium-modal" labelledBy="modal-title">
            <ModalHeader title="How Chasy P works" subtitle="Local-first by design, with a few honest tradeoffs." onClose={() => setModal(null)} />
            <div className="about-list">
              <div><LockKeyhole size={18} /><span><strong>No application database</strong><p>Profiles, friends, groups, and recent messages are kept in local storage on this device only.</p></span></div>
              <div><Radio size={18} /><span><strong>Relayed group traffic</strong><p>Group members who are not friends still reach each other: messages hop through any member who can carry them, up to {MAX_HOPS} hops, and are re-sent automatically when someone returns online.</p></span></div>
              <div><ImageIcon size={18} /><span><strong>Ephemeral icon images</strong><p>Custom 1:1 image icons (max 20 KB) are transmitted peer-to-peer and displayed only while the sender is online. When they go offline, the image disappears.</p></span></div>
              <div><Ban size={18} /><span><strong>Deletion logs</strong><p>Deleting your own message leaves a small “deleted a message” marker for the other person, which they can remove.</p></span></div>
              <div><Database size={18} /><span><strong>Retention</strong><p>Direct chats keep {DIRECT_LIMIT} entries; groups keep members × {GROUP_PER_MEMBER}. Deletion logs count too, and anything past 30 days is dropped.</p></span></div>
              <div><WifiOff size={18} /><span><strong>No server-side offline inbox</strong><p>Nothing waits on a server. Your browser queues outgoing messages, deletion notices, and group relays, then delivers them when both sides are online.</p></span></div>
              <div><BellRing size={18} /><span><strong>Deleted identities</strong><p>Each deleted identity leaves a note on this device. Every time you open Chasy P it looks for those people, and when one is reachable it tells them the account is gone. They remove it from their list and confirm, which clears the note.</p></span></div>
              <div><Clock size={18} /><span><strong>Deletion requests for offline friends</strong><p>If you submit a friend removal request and that friend remains offline without connecting for 1 month (30 days), you can finalize removal unilaterally.</p></span></div>
              <div><AlertTriangle size={18} /><span><strong>No guaranteed availability</strong><p>Chasy P is provided as-is. The app and the public signalling service it relies on may be suspended, changed, or discontinued at any time without prior notice.</p></span></div>
            </div>
            <div className="about-actions">
              <button className="secondary-button" onClick={exportData}><Download size={16} /> Export backup</button>
              <button className="secondary-button" onClick={() => setModal("import")}><FileUp size={16} /> Import backup</button>
            </div>
          </Modal>
        )}
        {incomingDelete && (
          <Modal onClose={() => setIncomingDelete(null)} className="small-modal" labelledBy="delete-request-title">
            <div className="danger-symbol warning-symbol"><AlertTriangle size={22} /></div>
            <h2 id="delete-request-title">Permanently delete this connection?</h2>
            <p className="modal-copy">{friends.find((friend) => friend.id === incomingDelete.friendId)?.nickname ?? "Your friend"} requested mutual deletion. If you agree, both sides must exchange a new connection number to become friends again.</p>
            <div className="modal-actions vertical-mobile"><button className="secondary-button" onClick={() => answerDeleteRequest(false)}>Keep connection</button><button className="danger-button" onClick={() => answerDeleteRequest(true)}>Agree and delete</button></div>
          </Modal>
        )}
        {incomingPurge && (
          <Modal onClose={() => setIncomingPurge(null)} className="small-modal" labelledBy="purge-request-title">
            <div className="danger-symbol warning-symbol"><Database size={22} /></div>
            <h2 id="purge-request-title">Erase all conversation data?</h2>
            <p className="modal-copy">{friends.find((friend) => friend.id === incomingPurge.friendId)?.nickname ?? "Your friend"} wants to erase every message and deletion log you two exchanged, on both devices. You stay friends.</p>
            <div className="modal-actions vertical-mobile"><button className="secondary-button" onClick={() => answerPurge(false)}>Keep history</button><button className="danger-button" onClick={() => answerPurge(true)}>Agree and erase</button></div>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && <motion.div className="toast" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}><CheckCircle2 size={17} />{toast}</motion.div>}
      </AnimatePresence>
    </main>
  );
}

export default App;
