/* ==========================================================================
   Agentic OS — Calendar
   Persistent local events with a month view, event editor, and reminders.
   ========================================================================== */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  calendarCreate, calendarDelete, calendarList, calendarUpdate,
} from "../utils/api";
import {
  CalendarDays, ChevronLeft, ChevronRight, Clock, Bell, Plus, X,
  Trash2, Pencil, Check, MapPin, CircleAlert,
} from "lucide-react";
import "./Calendar.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86400000;

function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localInput(date, time = true) {
  const d = new Date(date);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!time) return ymd;
  return `${ymd}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fromLocalInput(value) {
  const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
}

function prettyTime(iso, allDay) {
  if (allDay) return "All day";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function reminderTimestamp(start, choice) {
  const mins = { at: 0, "5m": 5, "15m": 15, "1h": 60, "1d": 1440 }[choice];
  return mins == null ? "" : new Date(start.getTime() - mins * 60000).toISOString();
}

function freshForm(date = new Date()) {
  const start = new Date(date);
  start.setHours(9, 0, 0, 0);
  return {
    id: "",
    title: "",
    description: "",
    startLocal: localInput(start),
    endLocal: "",
    allDay: false,
    reminder: "15m",
  };
}

function formFromEvent(event) {
  const start = new Date(event.startAt);
  const remindMins = event.remindAt ? Math.round((start.getTime() - new Date(event.remindAt).getTime()) / 60000) : null;
  const reminder = remindMins === 0 ? "at" : remindMins === 5 ? "5m" : remindMins === 15 ? "15m" : remindMins === 60 ? "1h" : remindMins === 1440 ? "1d" : "none";
  return {
    id: event.id,
    title: event.title,
    description: event.description || "",
    startLocal: event.allDay ? localInput(start, false) : localInput(start),
    endLocal: event.endAt ? (event.allDay ? localInput(event.endAt, false) : localInput(event.endAt)) : "",
    allDay: Boolean(event.allDay),
    reminder,
  };
}

function monthCells(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export default function Calendar() {
  const [events, setEvents] = useState([]);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  const [form, setForm] = useState(null);
  const [view, setView] = useState("month");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [permission, setPermission] = useState(() => ("Notification" in window ? Notification.permission : "unsupported"));

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await calendarList());
      setError("");
    } catch (err) {
      setError(err.message || "Couldn't load calendar events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    calendarList()
      .then((next) => {
        if (alive) setEvents(next);
      })
      .catch((err) => {
        if (alive) setError(err.message || "Couldn't load calendar events");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  const cells = useMemo(() => monthCells(month), [month]);
  const selectedKey = dateKey(selectedDate);
  const todayKey = dateKey(now);
  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const event of events) {
      const key = dateKey(event.startAt);
      map.set(key, [...(map.get(key) || []), event]);
    }
    for (const list of map.values()) list.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    return map;
  }, [events]);
  const upcoming = useMemo(
    () => events.filter((event) => Date.parse(event.endAt || event.startAt) >= now.getTime()).slice(0, 8),
    [events, now]
  );
  const dayEvents = eventsByDay.get(selectedKey) || [];

  function newEvent(date = selectedDate) {
    setSelectedDate(new Date(date));
    setForm(freshForm(date));
    setError("");
  }

  function editEvent(event) {
    setSelectedDate(new Date(event.startAt));
    setMonth(new Date(new Date(event.startAt).getFullYear(), new Date(event.startAt).getMonth(), 1));
    setForm(formFromEvent(event));
    setError("");
  }

  async function saveEvent(e) {
    e.preventDefault();
    const start = fromLocalInput(form.startLocal);
    if (!form.title.trim() || !Number.isFinite(start.getTime())) {
      setError("Add a title and a valid date/time.");
      return;
    }
    let end = form.endLocal ? fromLocalInput(form.endLocal) : null;
    if (form.allDay) {
      start.setHours(0, 0, 0, 0);
      if (end) end.setHours(0, 0, 0, 0);
      else end = new Date(start.getTime() + DAY_MS);
    }
    if (end && end < start) {
      setError("The end time must be after the start time.");
      return;
    }
    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      startAt: start.toISOString(),
      endAt: end ? end.toISOString() : "",
      remindAt: reminderTimestamp(start, form.reminder),
      allDay: form.allDay,
      source: "calendar",
    };
    setSaving(true);
    setError("");
    try {
      const saved = form.id ? await calendarUpdate(form.id, payload) : await calendarCreate(payload);
      await refresh();
      setSelectedDate(new Date(saved.startAt));
      setMonth(new Date(new Date(saved.startAt).getFullYear(), new Date(saved.startAt).getMonth(), 1));
      setForm(null);
      setNotice(form.id ? "Event updated" : "Event added to your calendar");
      setTimeout(() => setNotice(""), 2600);
    } catch (err) {
      setError(err.message || "Couldn't save event");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent() {
    if (!form?.id) return setForm(null);
    setSaving(true);
    try {
      await calendarDelete(form.id);
      await refresh();
      setForm(null);
      setNotice("Event removed");
      setTimeout(() => setNotice(""), 2600);
    } catch (err) {
      setError(err.message || "Couldn't remove event");
    } finally {
      setSaving(false);
    }
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setPermission("unsupported");
      return;
    }
    const result = await Notification.requestPermission();
    setPermission(result);
    setNotice(result === "granted" ? "Browser reminders enabled" : "Notifications were not enabled");
    setTimeout(() => setNotice(""), 2600);
  }

  function changeMonth(delta) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }

  return (
    <section className="calendar-page">
      <header className="calendar-header">
        <div className="calendar-brand">
          <span className="calendar-brand-icon"><CalendarDays size={20} /></span>
          <div>
            <h1>Calendar</h1>
            <p>Plans & reminders · saved in your Agentic OS</p>
          </div>
        </div>
        <div className="calendar-controls">
          <button className="calendar-btn ghost" onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); setSelectedDate(now); }}>Today</button>
          <button className="calendar-icon-btn" onClick={() => changeMonth(-1)} aria-label="Previous month"><ChevronLeft size={17} /></button>
          <button className="calendar-icon-btn" onClick={() => changeMonth(1)} aria-label="Next month"><ChevronRight size={17} /></button>
          <strong className="calendar-month-title">{month.toLocaleDateString([], { month: "long", year: "numeric" })}</strong>
          <div className="calendar-view-toggle">
            <button className={view === "month" ? "active" : ""} onClick={() => setView("month")}>Month</button>
            <button className={view === "agenda" ? "active" : ""} onClick={() => setView("agenda")}>Agenda</button>
          </div>
          <button className="calendar-btn primary" onClick={() => newEvent()}><Plus size={15} /> New event</button>
        </div>
      </header>

      <div className="calendar-content">
        <main className="calendar-main">
          {error && !form && <div className="calendar-error"><CircleAlert size={15} /> {error} <button onClick={refresh}>Retry</button></div>}
          {view === "month" ? (
            <div className="calendar-month-grid">
              <div className="calendar-weekdays">{WEEKDAYS.map((day) => <div key={day}>{day}</div>)}</div>
              <div className="calendar-days">
                {cells.map((day) => {
                  const key = dateKey(day);
                  const dayItems = eventsByDay.get(key) || [];
                  const today = key === todayKey;
                  return (
                    <button
                      key={key}
                      className={`calendar-day ${day.getMonth() !== month.getMonth() ? "outside" : ""} ${key === selectedKey ? "selected" : ""} ${today ? "today" : ""}`}
                      onClick={() => setSelectedDate(day)}
                      onDoubleClick={() => newEvent(day)}
                      aria-label={`${day.toLocaleDateString()}, ${dayItems.length} events`}
                    >
                      <span className="calendar-day-number">{day.getDate()}</span>
                      <span className="calendar-day-events">
                        {dayItems.slice(0, 3).map((event) => (
                          <span
                            key={event.id}
                            className={`calendar-event-chip ${event.source === "zazu" ? "from-zazu" : ""}`}
                            title={`${prettyTime(event.startAt, event.allDay)} · ${event.title}`}
                            onClick={(e) => { e.stopPropagation(); editEvent(event); }}
                          >
                            {!event.allDay && <span>{prettyTime(event.startAt, false)}</span>}{event.title}
                          </span>
                        ))}
                        {dayItems.length > 3 && <span className="calendar-more">+{dayItems.length - 3} more</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="calendar-agenda">
              <h2>Upcoming events</h2>
              {loading ? <p className="calendar-muted">Loading events…</p> : upcoming.length ? upcoming.map((event) => (
                <button className="calendar-agenda-event" key={event.id} onClick={() => editEvent(event)}>
                  <span className="agenda-date"><b>{new Date(event.startAt).toLocaleDateString([], { day: "2-digit" })}</b><small>{new Date(event.startAt).toLocaleDateString([], { month: "short" })}</small></span>
                  <span className="agenda-copy"><b>{event.title}</b><small><Clock size={12} /> {prettyTime(event.startAt, event.allDay)} · {new Date(event.startAt).toLocaleDateString()}</small>{event.description && <small>{event.description}</small>}</span>
                  {event.remindAt && <Bell size={14} className="agenda-bell" />}
                </button>
              )) : <p className="calendar-muted">No upcoming events yet. Add one to get started.</p>}
            </div>
          )}
        </main>

        <aside className="calendar-side">
          {form ? (
            <form className="calendar-form" onSubmit={saveEvent}>
              <div className="calendar-side-head">
                <div><span className="calendar-kicker">{form.id ? "EDIT EVENT" : "NEW EVENT"}</span><h2>{form.id ? "Update your plan" : "Add to your calendar"}</h2></div>
                <button type="button" className="calendar-icon-btn" onClick={() => setForm(null)} aria-label="Close event form"><X size={15} /></button>
              </div>
              <label className="calendar-field"><span>Title</span><input autoFocus value={form.title} maxLength={200} placeholder="What do you need to remember?" onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
              <label className="calendar-field"><span>Date & time</span><input type={form.allDay ? "date" : "datetime-local"} value={form.startLocal} required onChange={(e) => setForm({ ...form, startLocal: e.target.value })} /></label>
              {!form.allDay && <label className="calendar-field"><span>End time <small>(optional)</small></span><input type="datetime-local" value={form.endLocal} onChange={(e) => setForm({ ...form, endLocal: e.target.value })} /></label>}
              <label className="calendar-check"><input type="checkbox" checked={form.allDay} onChange={(e) => setForm({ ...form, allDay: e.target.checked, startLocal: localInput(fromLocalInput(form.startLocal), !e.target.checked) })} /><span>All day</span></label>
              <label className="calendar-field"><span>Reminder</span><select value={form.reminder} onChange={(e) => setForm({ ...form, reminder: e.target.value })}>
                <option value="none">No reminder</option><option value="at">At event time</option><option value="5m">5 minutes before</option><option value="15m">15 minutes before</option><option value="1h">1 hour before</option><option value="1d">1 day before</option>
              </select></label>
              <label className="calendar-field"><span>Notes <small>(optional)</small></span><textarea rows={3} value={form.description} placeholder="Details, location, or context…" onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              {error && <div className="calendar-error"><CircleAlert size={14} /> {error}</div>}
              <div className="calendar-form-actions">
                {form.id && <button type="button" className="calendar-btn danger" disabled={saving} onClick={deleteEvent}><Trash2 size={14} /> Delete</button>}
                <button type="button" className="calendar-btn ghost" onClick={() => setForm(null)}>Cancel</button>
                <button type="submit" className="calendar-btn primary" disabled={saving || !form.title.trim()}>{saving ? "Saving…" : <><Check size={14} /> {form.id ? "Save changes" : "Create event"}</>}</button>
              </div>
            </form>
          ) : (
            <div className="calendar-side-content">
              <div className="calendar-side-head">
                <div><span className="calendar-kicker">SELECTED DAY</span><h2>{selectedDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h2></div>
                <button className="calendar-icon-btn" onClick={() => newEvent(selectedDate)} title="Add event"><Plus size={16} /></button>
              </div>
              <div className="calendar-day-agenda">
                {dayEvents.length ? dayEvents.map((event) => (
                  <button key={event.id} className="calendar-detail-event" onClick={() => editEvent(event)}>
                    <span className={`event-color ${event.source === "zazu" ? "zazu" : ""}`} />
                    <span className="event-details"><b>{event.title}</b><small><Clock size={12} /> {prettyTime(event.startAt, event.allDay)}{event.endAt && !event.allDay ? ` – ${prettyTime(event.endAt, false)}` : ""}</small>{event.description && <small>{event.description}</small>}</span>
                    <Pencil size={13} className="event-edit-icon" />
                  </button>
                )) : <div className="calendar-empty-day"><CalendarDays size={24} /><span>Nothing planned for this day</span><button onClick={() => newEvent(selectedDate)}>Add an event</button></div>}
              </div>
              <div className="calendar-reminder-settings">
                <div className="reminder-settings-title"><span className="calendar-reminder-icon"><Bell size={15} /></span><div><b>Browser reminders</b><small>{permission === "granted" ? "Enabled on this device" : permission === "denied" ? "Blocked in browser settings" : permission === "unsupported" ? "Not supported in this browser" : "Allow notifications to be reminded"}</small></div></div>
                {permission === "default" && <button className="calendar-btn ghost" onClick={enableNotifications}>Enable notifications</button>}
                {permission === "granted" && <span className="calendar-enabled"><Check size={12} /> Enabled</span>}
              </div>
              <p className="calendar-zazu-tip"><MapPin size={13} /> Ask Zazu: “Remind me tomorrow at 9 to call Alex.”</p>
            </div>
          )}
        </aside>
      </div>
      {notice && <div className="calendar-toast"><Check size={14} /> {notice}</div>}
    </section>
  );
}

// Always mounted by App so reminders still fire when the user switches tabs.
export function CalendarReminderService() {
  const [alert, setAlert] = useState(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const events = await calendarList();
        if (!alive) return;
        const now = Date.now();
        for (const event of events) {
          if (!event.remindAt) continue;
          const due = Date.parse(event.remindAt);
          if (!Number.isFinite(due) || due > now || due < now - DAY_MS) continue;
          const seenKey = `agentic_os_calendar_notified_${event.id}_${event.remindAt}`;
          if (localStorage.getItem(seenKey)) continue;
          localStorage.setItem(seenKey, "1");
          const notificationTitle = `Reminder · ${event.title}`;
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification(notificationTitle, { body: event.description || new Date(event.startAt).toLocaleString(), tag: event.id });
          }
          setAlert({ id: event.id, title: event.title, description: event.description, at: Date.now() });
          setTimeout(() => setAlert((current) => current?.id === event.id ? null : current), 12000);
        }
      } catch { /* app can start before the proxy */ }
    };
    poll();
    const timer = setInterval(poll, 20000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!alert) return null;
  return (
    <div className="calendar-reminder-toast" role="status">
      <span className="calendar-reminder-icon"><Bell size={16} /></span>
      <div><b>Reminder: {alert.title}</b><small>{alert.description || "It's time for your event."}</small></div>
      <button onClick={() => setAlert(null)} aria-label="Dismiss reminder"><X size={15} /></button>
    </div>
  );
}
