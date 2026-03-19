# Mid-Loop Injection Templates — Clawdia 4.0
# ═══════════════════════════════════
# These are [SYSTEM] messages injected as user-role messages between
# tool iterations in the agentic loop. They steer the model without
# modifying the cached system prompt.
#
# Each template has:
#   - A trigger condition (when to inject)
#   - The message text (what the model sees)
#
# Variables: {{N}}, {{MAX}}, {{TOOL_NAME}}, {{ERROR}}, {{HINT}},
#            {{PARTS_REMAINING}}, {{USER_REQUEST_SUMMARY}}
# ═══════════════════════════════════


## APPROACHING_LIMIT
# Trigger: toolCallCount >= maxToolCalls - 3
[SYSTEM] You have {{REMAINING}} tool calls left. Prioritize completing the user's request. If you have enough information, stop and respond now.


## ITERATION_LIMIT_WARNING
# Trigger: iteration >= maxIterations - 2
[SYSTEM] Final iterations. Deliver your best answer with what you have gathered so far. Do not start new research threads.


## TOOL_ERROR_HINT
# Trigger: A tool returns an error
[SYSTEM] Tool `{{TOOL_NAME}}` failed: {{ERROR}}. {{HINT}}. Change your approach — do not retry the same command.


## INCOMPLETE_COVERAGE
# Trigger: After iteration 3, if the user's message contained multiple
#          questions or parts (detected by presence of "and", numbered
#          lists, or multiple question marks) and the model's tool calls
#          have only addressed one topic.
[SYSTEM] The user's request has multiple parts. You have addressed: {{PARTS_DONE}}. Still pending: {{PARTS_REMAINING}}. Address all parts before responding.


## NARRATION_WITHOUT_ACTION
# Trigger: Model response has text but zero tool calls, and the text
#          matches narration patterns ("I'll start by...", "Let me check...",
#          "I need to read...")
[SYSTEM] You described a plan but did not execute it. Use your tools now. Do not narrate — act.


## CAPABILITY_DENIAL
# Trigger: Model response contains phrases like "I can't access",
#          "I don't have the ability", "I'm unable to browse"
[SYSTEM] You have full system access: filesystem, shell, and browser. You CAN execute the action you just said you cannot. Use your tools.


## ESCALATION_NEEDED
# Trigger: Model produces a tool_use block for a tool name NOT in the
#          current tool group, OR model text says "I would need [tool X]"
[SYSTEM] Additional tools are now available. Proceed with your task.
# (The system adds the missing tools to the next API call)


## WALL_TIME_WARNING
# Trigger: elapsed > MAX_WALL_TIME * 0.8
[SYSTEM] Time limit approaching. Wrap up and deliver your response with current findings.


## FORCED_FINAL
# Trigger: maxIterations reached or wall time exceeded
# (This is sent as part of a forced final API call with no tools)
You have reached the tool call limit. Using only the information gathered in this conversation, provide your final response to the user. Be concise and complete.


## SIMPLE_GREETING
# Trigger: User message is a bare greeting ("hi", "hello", "hey", "yo")
# (Injected into dynamic context, not mid-loop)
The user sent a greeting. Reply in one sentence. Do not include project summaries, bullet lists, or suggestions — just acknowledge and ask what they need.
