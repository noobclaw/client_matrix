import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { defaultConfig } from '../../config';

export interface Model {
  id: string;
  name: string;
  provider?: string; // Provider the model belongs to
  providerKey?: string; // Provider key (used for unique identification)
  supportsImage?: boolean;
}

export function getModelIdentityKey(model: Pick<Model, 'id' | 'providerKey'>): string {
  return `${model.providerKey ?? ''}::${model.id}`;
}

export function isSameModelIdentity(
  modelA: Pick<Model, 'id' | 'providerKey'>,
  modelB: Pick<Model, 'id' | 'providerKey'>
): boolean {
  if (modelA.id !== modelB.id) {
    return false;
  }
  if (modelA.providerKey && modelB.providerKey) {
    return modelA.providerKey === modelB.providerKey;
  }
  // Backward compatibility: fall back to id matching when providerKey is missing
  return true;
}

// Build initial available model list from providers config
function buildInitialModels(): Model[] {
  const models: Model[] = [];
  if (defaultConfig.providers) {
    Object.entries(defaultConfig.providers).forEach(([providerName, config]) => {
      if (config.enabled && config.models) {
        config.models.forEach(model => {
          models.push({
            id: model.id,
            name: model.name,
            provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
            providerKey: providerName,
            supportsImage: model.supportsImage ?? false,
          });
        });
      }
    });
  }
  return models.length > 0 ? models : defaultConfig.model.availableModels;
}

// Initial available model list (updated at runtime)
export let availableModels: Model[] = buildInitialModels();
const defaultModelProvider = defaultConfig.model.defaultModelProvider;

interface ModelState {
  selectedModel: Model;
  availableModels: Model[];
}

const initialState: ModelState = {
  // Use the default model from config
  selectedModel: availableModels.find(
    model => model.id === defaultConfig.model.defaultModel
      && (!defaultModelProvider || model.providerKey === defaultModelProvider)
  ) || availableModels[0],
  availableModels: availableModels,
};

const modelSlice = createSlice({
  name: 'model',
  initialState,
  reducers: {
    setSelectedModel: (state, action: PayloadAction<Model>) => {
      state.selectedModel = action.payload;
    },
    setAvailableModels: (state, action: PayloadAction<Model[]>) => {
      state.availableModels = action.payload;
      // Update the exported availableModels
      availableModels = action.payload;
      // Sync selected model info to ensure the name matches the latest config
      if (action.payload.length > 0) {
        const matchedModel = action.payload.find(m => isSameModelIdentity(m, state.selectedModel));
        if (matchedModel) {
          state.selectedModel = matchedModel;
        } else {
          // If the currently selected model is not in the new available models list, select the first available model
          state.selectedModel = action.payload[0];
        }
      }
    },
  },
});

export const { setSelectedModel, setAvailableModels } = modelSlice.actions;
export default modelSlice.reducer; 
