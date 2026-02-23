import os

runtime_file = "src/core/session/session-runtime.ts"
with open(runtime_file, "r") as f:
    text = f.read()
text = text.replace(
    "routeBackendMessage?: (session: Session, msg: UnifiedMessage) => void;",
    "routeBackendMessage?: (session: Session, msg: UnifiedMessage, prevData?: SessionData) => void;"
)
text = text.replace(
    "const nextData = reduceSessionData(",
    "const prevData = this.session.data;\n    const nextData = reduceSessionData("
)
text = text.replace(
    "this.deps.routeBackendMessage?.(this.session, msg);",
    "this.deps.routeBackendMessage?.(this.session, msg, prevData);"
)
with open(runtime_file, "w") as f:
    f.write(text)

bridge_file = "src/core/bridge/session-bridge-deps-factory.ts"
with open(bridge_file, "r") as f:
    text = f.read()
text = text.replace(
    "routeBackendMessage: (session: Session, msg: UnifiedMessage) => {",
    "routeBackendMessage: (session: Session, msg: UnifiedMessage, prevData?: SessionData) => {"
)
text = text.replace(
    "params.router.route(session, msg);",
    "params.router.route(session, msg, prevData);"
)
with open(bridge_file, "w") as f:
    f.write(text)

router_file = "src/core/messaging/unified-message-router.ts"
with open(router_file, "r") as f:
    text = f.read()
text = text.replace(
    "route(session: Session, msg: UnifiedMessage): void {",
    "route(session: Session, msg: UnifiedMessage, prevData?: SessionData): void {"
)
text = text.replace(
    "const prevTeam = this.getState(session).team;",
    "const prevTeam = prevData ? prevData.state.team : this.getState(session).team;"
)
text = text.replace(
    "this.setState(session, reduceState(this.getState(session), msg, session.teamCorrelationBuffer));",
    ""
)
with open(router_file, "w") as f:
    f.write(text)

test_file = "src/core/messaging/unified-message-router.test.ts"
with open(test_file, "r") as f:
    text = f.read()

import re
text = re.sub(
    r'import { reduce as reduceState } from "\.\./session/session-state-reducer\.js";',
    'import { reduceSessionData } from "../session/session-state-reducer.js";',
    text
)
# Add a route helper at the top level describe
text = text.replace(
    "describe(\"UnifiedMessageRouter\", () => {",
    "describe(\"UnifiedMessageRouter\", () => {\n  const routeMessage = (session: any, m: any) => {\n    const prevData = session.data;\n    session.data = reduceSessionData(session.data, m, session.teamCorrelationBuffer || new (require(\"../session/team-tool-correlation-buffer.js\").TeamToolCorrelationBuffer)());\n    router.route(session, m, prevData);\n  };\n"
)
text = text.replace("router.route(", "routeMessage(")
with open(test_file, "w") as f:
    f.write(text)
