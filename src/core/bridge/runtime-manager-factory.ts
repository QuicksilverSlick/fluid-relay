import type { Session } from "../session/session-repository.js";
import { SessionRuntime, type SessionRuntimeDeps } from "../session/session-runtime.js";
import { RuntimeManager } from "./runtime-manager.js";

export interface RuntimeManagerFactoryDeps {
  now: SessionRuntimeDeps["now"];
  maxMessageHistoryLength: SessionRuntimeDeps["maxMessageHistoryLength"];
  getBroadcaster: () => SessionRuntimeDeps["broadcaster"];
  getQueueHandler: () => SessionRuntimeDeps["queueHandler"];
  getSlashService: () => SessionRuntimeDeps["slashService"];
  sendToBackend: SessionRuntimeDeps["sendToBackend"];
  tracedNormalizeInbound: SessionRuntimeDeps["tracedNormalizeInbound"];
  persistSession: SessionRuntimeDeps["persistSession"];
  warnUnknownPermission: SessionRuntimeDeps["warnUnknownPermission"];
  emitPermissionResolved: SessionRuntimeDeps["emitPermissionResolved"];
  onSessionSeeded: SessionRuntimeDeps["onSessionSeeded"];
  onInvalidLifecycleTransition: SessionRuntimeDeps["onInvalidLifecycleTransition"];
  routeBackendMessage: SessionRuntimeDeps["routeBackendMessage"];
  canMutateSession?: SessionRuntimeDeps["canMutateSession"];
  onMutationRejected?: SessionRuntimeDeps["onMutationRejected"];
  emitEvent: SessionRuntimeDeps["emitEvent"];
  getGitTracker: () => SessionRuntimeDeps["gitTracker"];
  gitResolver: SessionRuntimeDeps["gitResolver"];
  getCapabilitiesPolicy: () => SessionRuntimeDeps["capabilitiesPolicy"];
}

export function createRuntimeManager(deps: RuntimeManagerFactoryDeps): RuntimeManager {
  return new RuntimeManager(
    (session: Session) =>
      new SessionRuntime(session, {
        now: deps.now,
        maxMessageHistoryLength: deps.maxMessageHistoryLength,
        broadcaster: deps.getBroadcaster(),
        queueHandler: deps.getQueueHandler(),
        slashService: deps.getSlashService(),
        sendToBackend: deps.sendToBackend,
        tracedNormalizeInbound: deps.tracedNormalizeInbound,
        persistSession: deps.persistSession,
        warnUnknownPermission: deps.warnUnknownPermission,
        emitPermissionResolved: deps.emitPermissionResolved,
        onSessionSeeded: deps.onSessionSeeded,
        onInvalidLifecycleTransition: deps.onInvalidLifecycleTransition,
        routeBackendMessage: deps.routeBackendMessage,
        canMutateSession: deps.canMutateSession,
        onMutationRejected: deps.onMutationRejected,
        emitEvent: deps.emitEvent,
        gitTracker: deps.getGitTracker(),
        gitResolver: deps.gitResolver,
        capabilitiesPolicy: deps.getCapabilitiesPolicy(),
      }),
  );
}
