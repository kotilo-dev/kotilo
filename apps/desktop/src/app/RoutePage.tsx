/** Renders the page of a non-workspace route (the workspace itself stays mounted in `App`). */
import type { RouteId } from "./routes";
import { OverviewPage } from "../features/overview/OverviewPage";
import { MissionControlPage } from "../features/mission/MissionControlPage";
import { UsagePage } from "../features/usage/UsagePage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { TasksPage } from "../features/tasks/TasksPage";
import { SessionsPage } from "../features/sessions/SessionsPage";
import { DictationPage } from "../features/dictation/DictationPage";
import { SettingsPage } from "../features/settings/SettingsPage";

const PAGES: Record<Exclude<RouteId, "workspace">, () => JSX.Element> = {
  overview: OverviewPage,
  mission: MissionControlPage,
  usage: UsagePage,
  reports: ReportsPage,
  projects: ProjectsPage,
  tasks: TasksPage,
  sessions: SessionsPage,
  dictation: DictationPage,
  settings: SettingsPage,
};

export function RoutePage({ route }: { route: Exclude<RouteId, "workspace"> }) {
  const Page = PAGES[route];
  return <Page />;
}
