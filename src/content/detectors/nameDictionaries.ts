// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Large census name sets are stored in vendor/name-dictionaries.json and
// lazy-loaded on demand so they are not bundled synchronously into content.js.

let firstNamesSet: Set<string> | null = null;
let lastNamesSet: Set<string> | null = null;
let loadPromise: Promise<boolean> | null = null;
let skipNodeAutoLoad = false;

interface BuiltinProcess {
  versions?: { node?: string };
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}

function tryLoadSyncInNode(): boolean {
  if (skipNodeAutoLoad) return false;
  if (firstNamesSet && lastNamesSet) return true;
  const proc = (globalThis as { process?: BuiltinProcess }).process;
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function") {
    return false;
  }
  try {
    const fs = proc.getBuiltinModule("node:fs") as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string, enc: string) => string;
    };
    const path = proc.getBuiltinModule("node:path") as {
      resolve: (...parts: string[]) => string;
    };
    const cwd = typeof proc.cwd === "function" ? proc.cwd() : ".";
    const candidates = [
      path.resolve(cwd, "vendor", "name-dictionaries.json"),
      path.resolve(cwd, "dist", "assets", "name-dictionaries.json"),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        first?: string;
        last?: string;
      };
      firstNamesSet = new Set(raw.first ? raw.first.split("\n") : []);
      lastNamesSet = new Set(raw.last ? raw.last.split("\n") : []);
      return true;
    }
  } catch {
    // Fall through cleanly; name detection never gates on dictionary load.
  }
  return false;
}

export function isNameDictionariesLoaded(): boolean {
  return firstNamesSet !== null && lastNamesSet !== null;
}

export function setNameDictionariesFromPayload(first: string, last: string): void {
  firstNamesSet = new Set(first ? first.split("\n") : []);
  lastNamesSet = new Set(last ? last.split("\n") : []);
}

export function resetNameDictionariesForTests(disableAutoLoad = false): void {
  firstNamesSet = null;
  lastNamesSet = null;
  loadPromise = null;
  skipNodeAutoLoad = disableAutoLoad;
}

export async function ensureNameDictionariesLoaded(): Promise<boolean> {
  if (firstNamesSet && lastNamesSet) return true;
  if (tryLoadSyncInNode()) return true;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const cr = (globalThis as { chrome?: typeof chrome }).chrome;
      if (!cr?.runtime?.sendMessage) return false;
      const resp = (await cr.runtime.sendMessage({
        type: "CONTENT_GET_NAME_DICTIONARIES",
        requestId: `nd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      })) as { ok?: boolean; first?: string; last?: string } | undefined;
      if (resp?.ok && typeof resp.first === "string" && typeof resp.last === "string") {
        setNameDictionariesFromPayload(resp.first, resp.last);
        return true;
      }
    } catch {
      // Fail open to boost-only empty sets; name detection never gates on dictionary load.
    }
    return false;
  })();

  const ok = await loadPromise;
  if (!ok) loadPromise = null;
  return ok;
}

export function isFirstNameEntry(normToken: string): boolean {
  if (!firstNamesSet) tryLoadSyncInNode();
  return firstNamesSet ? firstNamesSet.has(normToken) : false;
}

export function isLastNameEntry(normToken: string): boolean {
  if (!lastNamesSet) tryLoadSyncInNode();
  return lastNamesSet ? lastNamesSet.has(normToken) : false;
}

export function isMiddleNameEntry(normToken: string): boolean {
  return isFirstNameEntry(normToken);
}

export const MIDDLE_INITIALS = new Set<string>(["A","A.","B","B.","C","C.","D","D.","E","E.","F","F.","G","G.","H","H.","I","I.","J","J.","K","K.","L","L.","M","M.","N","N.","O","O.","P","P.","Q","Q.","R","R.","S","S.","T","T.","U","U.","V","V.","W","W.","X","X.","Y","Y.","Z","Z."]);
export const NAME_PREFIXES = new Set<string>(["BR","BR.","CAPT","CAPT.","COL","COL.","DOCTOR","DR","DR.","FR","FR.","GEN","GEN.","HON","HON.","HONORABLE","JUDGE","LT","LT.","MISS","MISTER","MR","MR.","MRS","MRS.","MS","MS.","PASTOR","PROF","PROF.","PROFESSOR","RABBI","REV","REV.","REVEREND","SGT","SGT.","SR","SR."]);
export const NAME_SUFFIXES = new Set<string>(["II","III","IV","IX","JR","JR.","JUNIOR","SENIOR","SR","SR.","V","VI","VII","VIII","X"]);
export const PROFESSIONAL_CREDENTIALS = new Set<string>(["APRN","CNA","CNM","CRNA","DDS","DMD","DNP","DO","FNP-BC","FNP-C","LCSW","LPN","LVN","MD","NP","OT","PA-C","PHARMD","PHD","PT","RN","RRT"]);
export const GENDER_INDICATORS = new Set<string>(["F","FEMALE","M","MALE","MAN","W"]);
export const STOP_WORDS = new Set<string>(["A","ABOVE","AFTER","AGAINST","AM","AMONG","AN","AND","ARE","ARRIVED","AS","ASK","ASKED","AT","BECAME","BECOME","BEEN","BEFORE","BEING","BELOW","BETWEEN","BUT","BY","CALL","CALL","CALLED","CAME","CAN","CHART","CLAIM","COME","COULD","DID","DO","DOCUMENT","DOES","DURING","ELSE","FEEL","FELT","FILE","FILED","FIND","FOR","FORM","FOUND","FROM","GAVE","GET","GIVE","GO","GOING","GONE","GOT","HAD","HAS","HAVE","HELP","HELPED","HOW","IF","IN","INTO","IS","IT","ITS","KNOW","KNOWN","LEAVE","LEFT","LIKE","LIKED","LOOK","LOOKED","MADE","MAKE","MAY","MIGHT","MUST","NEED","NEED","NEEDED","NEEDS","NO","NOT","NOTE","NOTES","NOW","OF","ON","OR","OVER","PAGE","PAGES","PATIENT","PLEASE","PUT","RAN","REPORT","RUN","SAID","SAY","SAYING","SAYS","SEEN","SET","SHALL","SHOULD","SHOW","SHOWED","SINCE","TAKE","TELL","THAT","THE","THEN","THESE","THINK","THIS","THOSE","THOUGHT","THROUGH","TO","TODAY","TOLD","TOOK","TRIED","TRY","UNDER","UNTIL","UPON","USE","USED","VISIT","WANT","WANTED","WAS","WENT","WERE","WHAT","WHEN","WHERE","WHICH","WHO","WHOM","WHOSE","WHY","WILL","WITH","WITHIN","WITHOUT","WORK","WORKED","WOULD","YES"]);
