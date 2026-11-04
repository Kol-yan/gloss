"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PracticeSessionLoading } from "@/components/practice-session";
import { AccessUnavailable } from "@/components/invite-required";
import { useAccess } from "@/features/api/use-access";

// The guest session is created in the browser on the first visit. When the
// server render did not have a learner yet, wait for that session and then let
// the onboarding gate decide; practice itself never starts before onboarding.
export function PracticeEntryGate() {
  const router = useRouter();
  const { session } = useAccess();
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (session) router.replace("/onboarding");
  }, [session, router]);

  if (!session && waited) return <AccessUnavailable />;
  return <PracticeSessionLoading label="Getting your workspace ready." />;
}
