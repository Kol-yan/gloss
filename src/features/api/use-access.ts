"use client";

import { useSyncExternalStore } from "react";
import { getAccessSnapshot, getServerAccessSnapshot, subscribeAccess } from "./access-store";

export function useAccess() {
  return useSyncExternalStore(subscribeAccess, getAccessSnapshot, getServerAccessSnapshot);
}
