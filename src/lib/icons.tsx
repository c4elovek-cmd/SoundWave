/**
 * Значки приложения — Material Symbols Rounded.
 *
 * Компоненты повторяют API Phosphor Icons (size, weight, className, style,
 * title), поэтому в JSX используется так же: <Play size={20} weight="fill" />.
 * Стиль «fill» включает ось FILL шрифта, «light»/«bold» — ось веса.
 */

import { CSSProperties } from "react";

type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

interface IconProps {
  size?: number | string;
  weight?: IconWeight;
  color?: string;
  mirrored?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: (event: React.MouseEvent<HTMLSpanElement>) => void;
}

/** Имя Phosphor → лигатура Material Symbols Rounded. */
const NAMES: Record<string, string> = {
  MusicNotes: "music_note",
  ArrowSquareOut: "open_in_new",
  Globe: "public",
  ShieldCheck: "verified_user",
  Cookie: "cookie",
  SignOut: "logout",
  SignIn: "login",
  ArrowClockwise: "refresh",
  ArrowsClockwise: "autorenew",
  ArrowCounterClockwise: "restore",
  Heart: "favorite",
  HeartBreak: "heart_broken",
  CloudArrowUp: "cloud_upload",
  Play: "play_arrow",
  Pause: "pause",
  SkipBack: "skip_previous",
  SkipForward: "skip_next",
  Shuffle: "shuffle",
  Repeat: "repeat",
  RepeatOnce: "repeat_one",
  MagnifyingGlass: "search",
  X: "close",
  User: "person",
  House: "home",
  CaretLeft: "chevron_left",
  CaretRight: "chevron_right",
  Gear: "settings",
  Queue: "queue_music",
  Trash: "delete",
  WifiSlash: "wifi_off",
  WifiHigh: "wifi",
  Folder: "folder",
  FolderOpen: "folder_open",
  ArrowsIn: "close_fullscreen",
  ArrowsOut: "open_fullscreen",
  SpinnerGap: "progress_activity",
  ArrowLineUp: "arrow_upward",
  Playlist: "playlist_add",
  LinkSimple: "link",
  Microphone: "mic",
  TextAa: "text_fields",
  WarningCircle: "error",
  FloppyDisk: "save",
  Copy: "content_copy",
  Minus: "remove",
  Square: "maximize",
  SpeakerHigh: "volume_up",
  SpeakerLow: "volume_down",
  SpeakerX: "volume_off",
  PaintBrush: "brush",
  Plus: "add",
  Sliders: "tune",
  SidebarSimple: "view_sidebar",
  PencilSimple: "edit",
  CheckCircle: "check_circle",
  Check: "check",
  Info: "info",
  ThumbsDown: "thumb_down",
  Waveform: "graphic_eq",
  DownloadSimple: "download",
  ClipboardText: "content_paste",
};

/** Ось wght шрифта для каждого «веса» Phosphor. */
const WEIGHT_AXIS: Record<IconWeight, number> = {
  thin: 250,
  light: 300,
  regular: 400,
  bold: 600,
  fill: 400,
  duotone: 400,
};

function makeIcon(name: string) {
  const ligature = NAMES[name] ?? "help";

  const Icon = ({
    size = "1em",
    weight = "regular",
    color,
    mirrored,
    className,
    style,
    title,
    onClick,
  }: IconProps) => {
    const css: CSSProperties = {
      fontSize: size,
      fontVariationSettings: `'FILL' ${weight === "fill" ? 1 : 0}, 'wght' ${WEIGHT_AXIS[weight]}, 'GRAD' 0, 'opsz' 24`,
      color,
      transform: mirrored ? "scaleX(-1)" : undefined,
      ...style,
    };

    const spin = ligature === "progress_activity" ? "ms-spin" : "";

    return (
      <span
        className={`material-symbols-rounded ${spin} ${className ?? ""}`.trim()}
        style={css}
        onClick={onClick}
        role={title ? "img" : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
      >
        {ligature}
      </span>
    );
  };

  Icon.displayName = name;
  return Icon;
}

export const MusicNotes = makeIcon("MusicNotes");
export const ArrowSquareOut = makeIcon("ArrowSquareOut");
export const Globe = makeIcon("Globe");
export const ShieldCheck = makeIcon("ShieldCheck");
export const Cookie = makeIcon("Cookie");
export const SignOut = makeIcon("SignOut");
export const SignIn = makeIcon("SignIn");
export const ArrowClockwise = makeIcon("ArrowClockwise");
export const ArrowsClockwise = makeIcon("ArrowsClockwise");
export const ArrowCounterClockwise = makeIcon("ArrowCounterClockwise");
export const Heart = makeIcon("Heart");
export const HeartBreak = makeIcon("HeartBreak");
export const CloudArrowUp = makeIcon("CloudArrowUp");
export const Play = makeIcon("Play");
export const Pause = makeIcon("Pause");
export const SkipBack = makeIcon("SkipBack");
export const SkipForward = makeIcon("SkipForward");
export const Shuffle = makeIcon("Shuffle");
export const Repeat = makeIcon("Repeat");
export const RepeatOnce = makeIcon("RepeatOnce");
export const MagnifyingGlass = makeIcon("MagnifyingGlass");
export const X = makeIcon("X");
export const User = makeIcon("User");
export const House = makeIcon("House");
export const CaretLeft = makeIcon("CaretLeft");
export const CaretRight = makeIcon("CaretRight");
export const Gear = makeIcon("Gear");
export const Queue = makeIcon("Queue");
export const Trash = makeIcon("Trash");
export const WifiSlash = makeIcon("WifiSlash");
export const WifiHigh = makeIcon("WifiHigh");
export const Folder = makeIcon("Folder");
export const FolderOpen = makeIcon("FolderOpen");
export const ArrowsIn = makeIcon("ArrowsIn");
export const ArrowsOut = makeIcon("ArrowsOut");
export const SpinnerGap = makeIcon("SpinnerGap");
export const ArrowLineUp = makeIcon("ArrowLineUp");
export const Playlist = makeIcon("Playlist");
export const LinkSimple = makeIcon("LinkSimple");
export const Microphone = makeIcon("Microphone");
export const TextAa = makeIcon("TextAa");
export const WarningCircle = makeIcon("WarningCircle");
export const FloppyDisk = makeIcon("FloppyDisk");
export const Copy = makeIcon("Copy");
export const Minus = makeIcon("Minus");
export const Square = makeIcon("Square");
export const SpeakerHigh = makeIcon("SpeakerHigh");
export const SpeakerLow = makeIcon("SpeakerLow");
export const SpeakerX = makeIcon("SpeakerX");
export const PaintBrush = makeIcon("PaintBrush");
export const Plus = makeIcon("Plus");
export const Sliders = makeIcon("Sliders");
export const SidebarSimple = makeIcon("SidebarSimple");
export const PencilSimple = makeIcon("PencilSimple");
export const CheckCircle = makeIcon("CheckCircle");
export const Check = makeIcon("Check");
export const Info = makeIcon("Info");
export const ThumbsDown = makeIcon("ThumbsDown");
export const Waveform = makeIcon("Waveform");
export const DownloadSimple = makeIcon("DownloadSimple");
export const ClipboardText = makeIcon("ClipboardText");
