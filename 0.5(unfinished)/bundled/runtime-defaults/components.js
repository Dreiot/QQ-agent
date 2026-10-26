// Trusted startup composition defaults. Each named function is replaceable by
// an operator-owned composition module before any runtime object is created.
import { createKernel } from '../../src/kernel/kernel.js';
import { createLogger } from '../../src/kernel/log.js';
import { createLogPolicy } from '../../src/kernel/log-policy.js';
import { Bus } from '../../src/kernel/bus.js';
import { buildDefaultConfig, createConfig } from '../../src/kernel/config.js';
import { createCapabilityRegistry } from '../../src/kernel/capability.js';
import { createPermissions } from '../../src/kernel/permissions.js';
import { createToolRegistry } from '../../src/kernel/tools.js';
import { createScheduler } from '../../src/kernel/scheduler.js';
import { createStorage } from '../../src/kernel/storage.js';
import { createPluginLoader } from '../../src/kernel/plugin-loader.js';
import { createHttpServer } from '../../src/kernel/http.js';
import { createChatStore } from '../../src/kernel/store.js';
import { createMemoryStore } from '../../src/kernel/memory.js';
import { createSessionRegistry } from '../../src/kernel/sessions.js';
import { createUsageDayStore } from '../../src/kernel/usage-days.js';
import { createReminderStore } from '../../src/kernel/reminders.js';
import { createStickerManager } from '../../src/kernel/stickers.js';
import { createIngest } from '../../src/kernel/ingest.js';
import { resolveContextTier } from '../../src/kernel/wake.js';
import { requestMemoryConsolidation } from '../../src/console/memory-media-adapters.js';
import { readPersonaText, buildToolBundle, forwardLinkedMedia, handleProviderEvent } from './business.js';
import { createSendQueue, mdToPlain } from '../../src/kernel/send.js';
import { splitText } from '../../src/kernel/send-text.js';
import { createOrchestrator, personaForChat } from '../../src/kernel/orchestrator.js';
import { runAgent, parseInlineToolCalls } from '../../src/kernel/agent-runner.js';
import { rescueUnsentReply } from '../../src/kernel/reply-rescue.js';
import { buildSystemPrompt, buildUserPrompt, buildPastState, resolvePromptAnchor } from '../../src/kernel/prompt.js';
import { chatCompletionWithRetry, isRetryableError, selectPrimaryModelTarget } from '../../src/kernel/llm.js';
import { resolveThinkingPolicy } from '../../src/kernel/thinking-policy.js';
import { createServiceHost, serviceFacade } from '../../src/kernel/service-host.js';
import { createServiceLease } from '../../src/kernel/service-lease.js';
import { createSdkAccess } from '../../src/kernel/sdk-services.js';
import { safeFetch } from '../../src/kernel/safe-fetch.js';
import { detectMigrationSource, migrateFrom04 } from '../../src/kernel/migrator.js';
import { completePendingDataReset, createDataResetCoordinator } from '../../src/kernel/data-reset.js';
import { withInstanceLockTransaction } from '../../src/kernel/instance-lock.js';
import { registerComposedConsoleRoutes, usageCost } from '../../src/console/routes.js';
import {createExtensionUpdateController} from '../../src/console/extension-updates.js';
import { createPersonaTemplateController } from '../../src/console/persona-templates.js';
import { createPersonaByChatController } from '../../src/console/persona-by-chat.js';
import { createFeedbackDraftController } from '../../src/console/feedback-draft.js';
import { createModelPriceController } from '../../src/console/model-price-settings.js';
import { createPeakScheduleController } from '../../src/console/peak-schedule.js';
import { createBlocklistMemberController } from '../../src/console/blocklist-members.js';
import { createBlocklistRawController } from '../../src/console/blocklist-raw.js';
import { createSettingsSaveLifecycleController } from '../../src/console/settings-save-lifecycle.js';
import { createSessionNameController } from '../../src/console/session-names.js';
import { createMemberEditorController } from '../../src/console/member-editor.js';
import { createPanelAdapters, registerPanelRoutes } from '../../src/console/panel-adapters.js';
import { createSseBridge } from '../../src/console/sse-bridge.js';
import { createPriceUpdateAdapters } from '../../src/console/price-update-adapters.js';
import { createLocalProtocols } from '../../src/protocols/manager.js';
import { createProtocolLogin } from '../../src/protocols/login.js';
import { createAccountManager } from '../../src/accounts/manager.js';
import { createAccountGateway } from '../../src/accounts/gateway.js';
import { registerAccountRoutes } from '../../src/accounts/routes.js';
import { registerLocalProtocolRoutes } from '../../src/console/local-protocols.js';
import {registerLocalFontRoutes} from '../../src/console/local-fonts.js';
import {createGroupManagement} from '../../src/management/runtime.js';
import {registerGroupManagementRoutes} from '../../src/console/group-management.js';

export {
  createKernel, createLogger, createLogPolicy, buildDefaultConfig, createConfig, createCapabilityRegistry,
  createPermissions, createToolRegistry, createScheduler, createStorage, createPluginLoader,
  createHttpServer, createChatStore, createMemoryStore, createSessionRegistry, createUsageDayStore,
  createReminderStore, createStickerManager, createIngest, createSendQueue, createOrchestrator,
  runAgent, buildSystemPrompt, buildUserPrompt, buildPastState, resolvePromptAnchor,
  chatCompletionWithRetry, resolveThinkingPolicy, createServiceHost, serviceFacade, createSdkAccess, safeFetch,
  detectMigrationSource, migrateFrom04, completePendingDataReset, createDataResetCoordinator,
  withInstanceLockTransaction, registerComposedConsoleRoutes, usageCost, createPersonaTemplateController, createPersonaByChatController, createFeedbackDraftController, createMemberEditorController, createPanelAdapters,
  registerPanelRoutes, createSseBridge, createPriceUpdateAdapters,
  resolveContextTier, requestMemoryConsolidation, readPersonaText, buildToolBundle, forwardLinkedMedia, handleProviderEvent,
  mdToPlain, splitText, rescueUnsentReply, createModelPriceController, createPeakScheduleController, personaForChat, parseInlineToolCalls, isRetryableError,
};

export const createBus = ({ log } = {}) => new Bus(log);

// Factories use the original named export's argument and return contracts.
// Call-through functions (prompts, LLM, routes, migration, fetch, lock) retain
// their original signatures; they are not factories and must not be pre-run.
export const defaultComponents = Object.freeze({
  'runtime.kernel': createKernel,
  'runtime.persona.text': readPersonaText,
  'runtime.logger': createLogger,
  'runtime.log.policy': createLogPolicy,
  'runtime.bus': createBus,
  'runtime.config.defaults': buildDefaultConfig,
  'runtime.config': createConfig,
  'runtime.capability': createCapabilityRegistry,
  'runtime.permissions': createPermissions,
  'runtime.tools': createToolRegistry,
  'runtime.scheduler': createScheduler,
  'runtime.storage': createStorage,
  'runtime.plugins': createPluginLoader,
  'runtime.http': createHttpServer,
  'runtime.sdk': createSdkAccess,
  'runtime.services': createServiceHost,
  'runtime.serviceFacade': serviceFacade,
  'runtime.serviceLease': createServiceLease,
  'runtime.fetch': safeFetch,
  'runtime.priceUpdates': createPriceUpdateAdapters,
  'runtime.localProtocols': createLocalProtocols,
  'runtime.protocolLogin': createProtocolLogin,
  'runtime.accounts': createAccountManager,
  'runtime.accountGateway': createAccountGateway,
  'console.accounts': registerAccountRoutes,
  'runtime.reset.complete': completePendingDataReset,
  'runtime.reset': createDataResetCoordinator,
  'runtime.migration.detect': detectMigrationSource,
  'runtime.migration.run': migrateFrom04,
  'runtime.instanceLock': withInstanceLockTransaction,
  'data.messages': createChatStore,
  'data.memory': createMemoryStore,
  'data.sessions': createSessionRegistry,
  'data.usage': createUsageDayStore,
  'data.reminders': createReminderStore,
  'data.stickers': createStickerManager,
  'core.tools.bundle': buildToolBundle,
  'core.media.forward': forwardLinkedMedia,
  'core.events': handleProviderEvent,
  'core.wake.resolve': resolveContextTier,
  'core.memory.consolidate': requestMemoryConsolidation,
  'core.text.plain': mdToPlain,
  'core.text.split': splitText,
  'core.prompt.persona': personaForChat,
  'core.tools.parseInline': parseInlineToolCalls,
  'core.reply.rescue': rescueUnsentReply,
  'core.session.retryable': isRetryableError,
  'core.ingest': createIngest,
  'core.management': createGroupManagement,
  'core.send': createSendQueue,
  'core.orchestrator': createOrchestrator,
  'core.prompt.system': buildSystemPrompt,
  'core.prompt.user': buildUserPrompt,
  'core.prompt.pastState': buildPastState,
  'core.prompt.anchor': resolvePromptAnchor,
  'core.agentRunner': runAgent,
  'llm.complete': chatCompletionWithRetry,
  'llm.target': selectPrimaryModelTarget,
  'llm.thinking': resolveThinkingPolicy,
  'console.routes': registerComposedConsoleRoutes,
  'console.extensionUpdates': createExtensionUpdateController,
  'console.localProtocols': registerLocalProtocolRoutes,
  'console.localFonts': registerLocalFontRoutes,
  'console.management': registerGroupManagementRoutes,
  'console.personaTemplates': createPersonaTemplateController,
  'console.personaByChat': createPersonaByChatController,
  'console.feedbackDraft': createFeedbackDraftController,
  'console.modelPrices': createModelPriceController,
  'console.peakSchedule': createPeakScheduleController,
  'console.blocklistMembers': createBlocklistMemberController,
  'console.blocklistRaw': createBlocklistRawController,
  'console.settingsSaveLifecycle': createSettingsSaveLifecycleController,
  'console.sessionNames': createSessionNameController,
  'console.memberEditor': createMemberEditorController,
  'console.panels': createPanelAdapters,
  'console.panelRoutes': registerPanelRoutes,
  'console.sse': createSseBridge,
  'console.usageCost': usageCost,
});

export default defaultComponents;
