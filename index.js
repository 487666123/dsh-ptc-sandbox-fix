import { ESCALATION_TARGETS, WIDER_MODES } from '@deepseek-ai/dsh-sandbox';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';

// 内置 PTC 预设的标识，用于限定插件的作用范围。
const PRESET_ID = 'ptc';
// PTC 暴露给模型的外层工具名，嵌套工具使用各自的定义。
const RUN_CODE = 'run_code';
// 官方 run_code 工具描述中关于升级的原文。隐藏升级字段时同步移除这段说明，保留其余描述。
const ESCALATION_GUIDANCE = ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial.';

// Cordis 插件名称和加载所需的宿主服务。
export const name = 'PTC 沙箱参数修复';
export const inject = ['agents', 'agentPresets', 'tools', 'sandboxPolicy', 'approval', 'ptcRuntime'];

// 根据会话可申请的升级目标调整发给模型的工具定义，保留官方定义原件。
function projectSchema(schema, targets) {
    if (schema.name !== RUN_CODE) return schema;
    const parameters = schema.parameters;
    const permissions = parameters?.properties?.sandbox_permissions;
    if (!Array.isArray(permissions?.enum) || !parameters.properties.justification) return schema;

    // 取官方枚举与当前可申请目标的交集，并保留官方枚举顺序。
    const allowed = permissions.enum.filter((mode) => targets.includes(mode));
    const properties = { ...parameters.properties };
    if (allowed.length > 0) {
        properties.sandbox_permissions = { ...permissions, enum: allowed };
        return { ...schema, parameters: { ...parameters, properties } };
    }

    // 没有可申请的目标时，同步移除两个字段及其必填约束。
    delete properties.sandbox_permissions;
    delete properties.justification;
    const projected = { ...parameters, properties };
    if (Array.isArray(projected.required)) {
        projected.required = projected.required.filter((field) => field !== 'sandbox_permissions' && field !== 'justification');
        if (projected.required.length === 0) delete projected.required;
    }
    return {
        ...schema,
        description: schema.description.replace(ESCALATION_GUIDANCE, ''),
        parameters: projected,
    };
}

// 执行前处理冗余的升级参数。被修改的调用通过副本提交，原始调用仍保留在会话中。
function normalizeCall(call, effectiveMode) {
    if (call.name !== RUN_CODE || typeof call.arguments !== 'string') return call;
    let args;
    try {
        args = JSON.parse(call.arguments);
    } catch {
        return call;
    }
    // 只处理对象中成对出现的已知目标和字符串理由，其余输入由官方执行器校验。
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return call;
    if (!Object.hasOwn(args, 'sandbox_permissions') || !Object.hasOwn(args, 'justification')) return call;
    if (!ESCALATION_TARGETS.includes(args.sandbox_permissions) || typeof args.justification !== 'string') return call;

    // 权限参数只表示本次执行的临时升级。严格更宽的请求交给官方流程审批。
    if ((WIDER_MODES[effectiveMode] ?? []).includes(args.sandbox_permissions)) return call;
    delete args.sandbox_permissions;
    delete args.justification;
    return { ...call, arguments: JSON.stringify(args) };
}

// 包装官方执行器，沿用其系统提示词段落、执行流程和环境重置。
function wrapExecutor(ctx, agent, executor) {
    const mode = () => ctx.sandboxPolicy.resolve({ session: agent.session }).mode;
    return {
        sections: executor.sections,
        describe(tools) {
            const description = executor.describe(tools);
            // 生成工具定义时，若当前策略允许询问审批，则列出比当前沙箱模式更宽的目标。
            const targets = ctx.approval.effectivePolicy(agent.session) === 'ask' ? WIDER_MODES[mode()] ?? [] : [];
            return { ...description, schemas: description.schemas.map((schema) => projectSchema(schema, targets)) };
        },
        execute(input) {
            if (input.agent !== agent || input.signal.aborted || ctx.ptcRuntime.sandboxMode === undefined) {
                return executor.execute(input);
            }
            // 权限可能在模型请求发出后切换，执行时以会话的最新模式判断升级是否冗余。
            const effectiveMode = mode();
            const calls = input.calls.map((call) => normalizeCall(call, effectiveMode));
            return executor.execute(calls.some((call, index) => call !== input.calls[index]) ? { ...input, calls } : input);
        },
        reset(owner) {
            return executor.reset(owner);
        },
    };
}

export function apply(ctx) {
    const registrations = new Map();
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/start') return;
        const agent = ctx.agents.get(session.id);
        if (!agent || agent.session !== session || registrations.has(agent)) return;
        if (ctx.agentPresets.composedPreset(agent.ctx) !== PRESET_ID) return;

        // 首轮开始时预设已确定，执行器在此次模型请求组装前注册。
        const executor = ctx.tools.selectExecutor(agent);
        if (!(executor instanceof PtcExecutor)) return;
        const dispose = agent.ctx.tools.setExecutor(wrapExecutor(ctx, agent, executor));
        registrations.set(agent, dispose);
    });
    ctx.on('agent/disposed', ({ agent }) => {
        const dispose = registrations.get(agent);
        registrations.delete(agent);
        return dispose?.();
    });
    ctx.effect(() => async () => {
        const disposers = [...registrations.values()];
        registrations.clear();
        await Promise.all(disposers.map((dispose) => dispose()));
    });
}
