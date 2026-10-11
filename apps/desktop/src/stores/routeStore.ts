/** Active app route (M2 shell). The workspace stays mounted while another route is shown. */
import { create } from "zustand";
import type { RouteId } from "../app/routes";

interface RouteStore {
  route: RouteId;
  navigate: (route: RouteId) => void;
}

export const useRouteStore = create<RouteStore>((set) => ({
  route: "workspace",
  navigate: (route) => set({ route }),
}));
