import { useEffect, useState } from "react";
import { KeelEngine, type Snapshot } from "@/lib/keel/engine";

export function useKeel() {
  const [engine] = useState(() => new KeelEngine());
  const [snap, setSnap] = useState<Snapshot>(() => engine.getSnapshot());

  useEffect(() => {
    const unsubscribe = engine.subscribe(setSnap);
    engine.start();
    return () => {
      unsubscribe();
      engine.dispose();
    };
  }, [engine]);

  return { snap, api: engine };
}
