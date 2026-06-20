import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LocalizedQuickAction } from '../../types/quickAction';

interface QuickActionState {
  /** Quick action list (localized) */
  actions: LocalizedQuickAction[];
  /** Currently selected action ID */
  selectedActionId: string | null;
  /** Currently selected prompt ID */
  selectedPromptId: string | null;
  /** Whether loading is in progress */
  isLoading: boolean;
}

const initialState: QuickActionState = {
  actions: [],
  selectedActionId: null,
  selectedPromptId: null,
  isLoading: false,
};

const quickActionSlice = createSlice({
  name: 'quickAction',
  initialState,
  reducers: {
    /** Set quick action list */
    setActions: (state, action: PayloadAction<LocalizedQuickAction[]>) => {
      state.actions = action.payload;
    },
    /** Select quick action */
    selectAction: (state, action: PayloadAction<string | null>) => {
      state.selectedActionId = action.payload;
      // Clear prompt selection when switching action
      state.selectedPromptId = null;
    },
    /** Select prompt */
    selectPrompt: (state, action: PayloadAction<string | null>) => {
      state.selectedPromptId = action.payload;
    },
    /** Set loading state */
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    /** Clear selection */
    clearSelection: (state) => {
      state.selectedActionId = null;
      state.selectedPromptId = null;
    },
  },
});

export const {
  setActions,
  selectAction,
  selectPrompt,
  setLoading,
  clearSelection,
} = quickActionSlice.actions;

export default quickActionSlice.reducer;
