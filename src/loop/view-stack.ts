/**
 * AgentViewStack — tracks UI component ownership across multi-agent execution.
 *
 * When a sub-agent switches the active component, its view is pushed onto the
 * stack. On completion, the stack is popped and the parent's last component
 * can be restored (unless the parent immediately switches again).
 *
 * @module loop/view-stack
 */

export interface AgentViewState {
  agentId: string;
  activeComponent: string;
  lastSwitchAt: number;
}

export class AgentViewStack {
  private stack: AgentViewState[] = [];

  /** Push a new agent's view state when delegation begins. */
  push(agentId: string): void {
    this.stack.push({
      agentId,
      activeComponent: '',
      lastSwitchAt: Date.now(),
    });
  }

  /** Pop the top agent's view state when delegation completes. Returns the popped state. */
  pop(): AgentViewState | undefined {
    return this.stack.pop();
  }

  /** Get the current (top) view state. */
  current(): AgentViewState | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }

  /** Record a SWITCH_COMPONENT event for the given agent. */
  recordSwitch(agentId: string, component: string): void {
    // Update the matching entry (could be anywhere in the stack for persistent agents)
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].agentId === agentId) {
        this.stack[i].activeComponent = component;
        this.stack[i].lastSwitchAt = Date.now();
        return;
      }
    }
    // If agent not in stack, push it (first switch)
    this.stack.push({ agentId, activeComponent: component, lastSwitchAt: Date.now() });
  }

  /** Get the previous agent's view (for restore-on-pop). */
  previous(): AgentViewState | undefined {
    return this.stack.length > 1 ? this.stack[this.stack.length - 2] : undefined;
  }

  get depth(): number {
    return this.stack.length;
  }

  clear(): void {
    this.stack = [];
  }
}
