import type { LucideIcon } from "lucide-react-native";
import Activity from "lucide-react-native/icons/activity";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import ArrowRight from "lucide-react-native/icons/arrow-right";
import ArrowUp from "lucide-react-native/icons/arrow-up";
import Bell from "lucide-react-native/icons/bell";
import Bookmark from "lucide-react-native/icons/bookmark";
import Camera from "lucide-react-native/icons/camera";
import Check from "lucide-react-native/icons/check";
import CircleCheck from "lucide-react-native/icons/circle-check";
import CircleX from "lucide-react-native/icons/circle-x";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import CloudOff from "lucide-react-native/icons/cloud-off";
import Compass from "lucide-react-native/icons/compass";
import Database from "lucide-react-native/icons/database";
import Download from "lucide-react-native/icons/download";
import Ellipsis from "lucide-react-native/icons/ellipsis";
import ExternalLink from "lucide-react-native/icons/external-link";
import FileText from "lucide-react-native/icons/file-text";
import FingerprintPattern from "lucide-react-native/icons/fingerprint-pattern";
import Folder from "lucide-react-native/icons/folder";
import FolderOpen from "lucide-react-native/icons/folder-open";
import Images from "lucide-react-native/icons/images";
import Info from "lucide-react-native/icons/info";
import Layers2 from "lucide-react-native/icons/layers-2";
import MessagesSquare from "lucide-react-native/icons/messages-square";
import Mic from "lucide-react-native/icons/mic";
import Paperclip from "lucide-react-native/icons/paperclip";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import Rocket from "lucide-react-native/icons/rocket";
import Search from "lucide-react-native/icons/search";
import Settings from "lucide-react-native/icons/settings";
import Sparkles from "lucide-react-native/icons/sparkles";
import Square from "lucide-react-native/icons/square";
import SquarePen from "lucide-react-native/icons/square-pen";
import Terminal from "lucide-react-native/icons/terminal";
import Trash2 from "lucide-react-native/icons/trash-2";
import UserRound from "lucide-react-native/icons/user-round";
import Wifi from "lucide-react-native/icons/wifi";
import X from "lucide-react-native/icons/x";
import Zap from "lucide-react-native/icons/zap";

export const icons = {
  activity: Activity,
  alert: CircleAlert,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up": ArrowUp,
  bell: Bell,
  bookmark: Bookmark,
  camera: Camera,
  check: Check,
  "check-circle": CircleCheck,
  "circle-x": CircleX,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "cloud-off": CloudOff,
  compass: Compass,
  database: Database,
  download: Download,
  "external-link": ExternalLink,
  "file-text": FileText,
  fingerprint: FingerprintPattern,
  folder: Folder,
  "folder-open": FolderOpen,
  images: Images,
  info: Info,
  layers: Layers2,
  messages: MessagesSquare,
  mic: Mic,
  more: Ellipsis,
  paperclip: Paperclip,
  plus: Plus,
  refresh: RefreshCw,
  rocket: Rocket,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  "square-pen": SquarePen,
  stop: Square,
  sync: RefreshCw,
  terminal: Terminal,
  trash: Trash2,
  user: UserRound,
  wifi: Wifi,
  x: X,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;
