/* ==========================================================================
   Agentic OS — App
   Root shell: nav rail (tabs) + the active tab page (Chat / Agents / Vault).
   ========================================================================== */
import { useState, useEffect } from "react";
import Chat from "./components/Chat";
import Home from "./components/Home";
import Agents from "./components/Agents";
import Health from "./components/Health";
import Vault from "./components/Vault";
import Calendar, { CalendarReminderService } from "./components/Calendar";
import Skills from "./components/Skills";
import Projects from "./components/Projects";
import Routines from "./components/Routines";
import Security from "./components/Security";
import ZazuPanel from "./components/ZazuPanel";
import ResizeHandle from "./components/ResizeHandle";
import ErrorBoundary from "./components/ErrorBoundary";
import { useResizableWidth } from "./utils/useResizableWidth";
import { Home as HomeIcon, MessageSquare, Bot, FolderOpen, CalendarDays, Puzzle, Code2, Activity, Repeat, ShieldCheck } from "lucide-react";

const NAVIGATE_EVENT = "agentic_os_navigate";

export default function App() {
  const [tab, setTab] = useState("home");
  const rightRail = useResizableWidth({
    storageKey: "agentic_os_width_right_rail",
    defaultValue: 400,
    min: 300,
    max: 680,
    side: "left",
  });

  // Listen for navigation events from ZazuPanel
  useEffect(() => {
    const handleNavigate = (e) => {
      const targetTab = e.detail?.tab;
      const validTabs = ["home", "chat", "agents", "health", "routines", "vault", "calendar", "skills", "projects", "security", "settings"];
      if (targetTab && validTabs.includes(targetTab)) {
        setTab(targetTab);
      }
    };
    window.addEventListener(NAVIGATE_EVENT, handleNavigate);
    return () => window.removeEventListener(NAVIGATE_EVENT, handleNavigate);
  }, []);

  return (
    <div className="app">
      <div className="app-bg" />
      <div className="glow" />
      <div className="glow" />
      <div className="scanline" />

      {/* Left nav rail with tabs */}
      <nav className="nav-rail">
        <div className="rail-brand" title="Agentic OS">&#9678;</div>
        <button
          className={`rail-tab ${tab === "home" ? "active" : ""}`}
          title="Home — today at a glance"
          onClick={() => setTab("home")}
        >
          <HomeIcon />
          <span>Home</span>
        </button>
        <button
          className={`rail-tab ${tab === "chat" ? "active" : ""}`}
          title="Chat"
          onClick={() => setTab("chat")}
        >
          <MessageSquare />
          <span>Chat</span>
        </button>
        <button
          className={`rail-tab ${tab === "agents" ? "active" : ""}`}
          title="Agents"
          onClick={() => setTab("agents")}
        >
          <Bot />
          <span>Agents</span>
        </button>
        <button
          className={`rail-tab ${tab === "health" ? "active" : ""}`}
          title="Model Health"
          onClick={() => setTab("health")}
        >
          <Activity />
          <span>Health</span>
        </button>
        <button
          className={`rail-tab ${tab === "routines" ? "active" : ""}`}
          title="Routines — scheduled Zazu tasks"
          onClick={() => setTab("routines")}
        >
          <Repeat />
          <span>Routines</span>
        </button>
        <button
          className={`rail-tab ${tab === "vault" ? "active" : ""}`}
          title="Vault"
          onClick={() => setTab("vault")}
        >
          <FolderOpen />
          <span>Vault</span>
        </button>
        <button
          className={`rail-tab ${tab === "calendar" ? "active" : ""}`}
          title="Calendar"
          onClick={() => setTab("calendar")}
        >
          <CalendarDays />
          <span>Calendar</span>
        </button>
        <button
          className={`rail-tab ${tab === "skills" ? "active" : ""}`}
          title="Skills"
          onClick={() => setTab("skills")}
        >
          <Puzzle />
          <span>Skills</span>
        </button>
        <button
          className={`rail-tab ${tab === "projects" ? "active" : ""}`}
          title="Projects"
          onClick={() => setTab("projects")}
        >
          <Code2 />
          <span>Projects</span>
        </button>
        <button
          className={`rail-tab ${tab === "security" ? "active" : ""}`}
          title="Security and GitHub pre-publish audit"
          onClick={() => setTab("security")}
        >
          <ShieldCheck />
          <span>Security</span>
        </button>
        <div className="rail-spacer" />
      </nav>

      <div className="tab-content">
        <ErrorBoundary>
          {tab === "home" ? <Home /> : tab === "chat" ? <Chat /> : tab === "agents" ? <Agents /> : tab === "health" ? <Health /> : tab === "routines" ? <Routines /> : tab === "vault" ? <Vault /> : tab === "calendar" ? <Calendar /> : tab === "skills" ? <Skills /> : tab === "projects" ? <Projects /> : tab === "security" ? <Security /> : <Vault />}
        </ErrorBoundary>
      </div>

      {/* Right sidebar — Zazu, always available on every tab (drag edge to resize) */}
      <ResizeHandle side="left" onDragStart={rightRail.startDrag} onReset={rightRail.reset} />
      <aside className="right-rail" style={{ width: rightRail.width }}>
        <ErrorBoundary>
          <ZazuPanel />
        </ErrorBoundary>
      </aside>
      <CalendarReminderService />
    </div>
  );
}
