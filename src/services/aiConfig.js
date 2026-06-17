/**
 * Central AI model configuration.
 *
 * Model names are stored in AppSettings (key 'ai_models') so they can be changed from the admin
 * UI when a model is retired — no code change or redeploy needed. Values are cached in memory and
 * refreshed at startup and whenever they're saved.
 *
 *   parsingModel  — heavier work: RFQ/estimate parsing, document & invoice (vision) extraction, Ginger.
 *   triageModel   — cheap, high-volume Comm Center classification.
 */

const DEFAULTS = {
  parsingModel: 'claude-sonnet-4-6',
  triageModel: 'claude-haiku-4-5-20251001',
};

let models = { ...DEFAULTS };

async function loadAiModels() {
  try {
    const { AppSettings } = require('../models');
    const row = await AppSettings.findOne({ where: { key: 'ai_models' } });
    if (row && row.value) {
      models = {
        parsingModel: row.value.parsingModel || DEFAULTS.parsingModel,
        triageModel: row.value.triageModel || DEFAULTS.triageModel,
      };
    }
    console.log(`[aiConfig] Models loaded: parsing=${models.parsingModel}, triage=${models.triageModel}`);
  } catch (e) {
    console.warn('[aiConfig] Could not load models, using defaults:', e.message);
  }
  return models;
}

function getAiModels() { return { ...models }; }
function getParsingModel() { return models.parsingModel; }
function getTriageModel() { return models.triageModel; }
function setAiModels(next = {}) {
  models = {
    parsingModel: next.parsingModel || models.parsingModel,
    triageModel: next.triageModel || models.triageModel,
  };
  return getAiModels();
}

module.exports = { DEFAULTS, loadAiModels, getAiModels, getParsingModel, getTriageModel, setAiModels };
