// Icons come from Lucide (https://lucide.dev). Only the ones used are imported, so the bundle
// stays small. icon('play') returns a fresh <svg> element.

import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  Clock,
  CornerDownLeft,
  EllipsisVertical,
  ExternalLink,
  EyeOff,
  Gem,
  History,
  House,
  LayoutGrid,
  Library,
  ListPlus,
  ListVideo,
  Moon,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Share2,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TrendingUp,
  X,
  createElement,
} from 'lucide';

const ICONS = {
  'arrow-down': ArrowDown,
  'arrow-up': ArrowUp,
  ban: Ban,
  check: Check,
  clock: Clock,
  enter: CornerDownLeft,
  more: EllipsisVertical,
  external: ExternalLink,
  'eye-off': EyeOff,
  gem: Gem,
  history: History,
  home: House,
  topics: LayoutGrid,
  library: Library,
  'list-plus': ListPlus,
  queue: ListVideo,
  moon: Moon,
  pencil: Pencil,
  play: Play,
  plus: Plus,
  undo: RotateCcw,
  search: Search,
  share: Share2,
  next: SkipForward,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  sun: Sun,
  down: ThumbsDown,
  up: ThumbsUp,
  trash: Trash2,
  trending: TrendingUp,
  x: X,
};

export function icon(name, attrs = {}) {
  const node = ICONS[name];
  if (!node) throw new Error(`unknown icon ${name}`);
  return createElement(node, { 'aria-hidden': 'true', focusable: 'false', ...attrs });
}

/** Replace every <i data-icon="name"> in `root` with its Lucide icon (used by index.html). */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    const svg = icon(el.dataset.icon);
    if (el.className) svg.setAttribute('class', `${svg.getAttribute('class') ?? ''} ${el.className}`.trim());
    el.replaceWith(svg);
  }
}
