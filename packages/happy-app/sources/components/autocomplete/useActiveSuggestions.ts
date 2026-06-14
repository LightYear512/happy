import { ValueSync } from '@/utils/sync';
import * as React from 'react';
import type { AutocompleteSuggestion } from './types';

interface SuggestionOptions {
    clampSelection?: boolean;  // If true, clamp instead of preserving exact position
    autoSelectFirst?: boolean; // If true, automatically select first item when suggestions appear
    wrapAround?: boolean;      // If true, wrap around when reaching top/bottom
}

export function useActiveSuggestions(
    query: string | null,
    handler: (query: string) => Promise<AutocompleteSuggestion[]>,
    options: SuggestionOptions = {}
) {
    const {
        clampSelection = true,
        autoSelectFirst = true,
        wrapAround = true
    } = options;

    // State for suggestions
    const [state, setState] = React.useState<{
        suggestions: AutocompleteSuggestion[];
        selected: number,
    }>({
        suggestions: [],
        selected: -1
    });

    const firstEnabledIndex = React.useCallback((suggestions: AutocompleteSuggestion[]): number => {
        return suggestions.findIndex(suggestion => !suggestion.disabled);
    }, []);

    const clampToEnabled = React.useCallback((suggestions: AutocompleteSuggestion[], index: number): number => {
        if (suggestions.length === 0) return -1;
        if (index >= 0 && index < suggestions.length && !suggestions[index].disabled) return index;
        return firstEnabledIndex(suggestions);
    }, [firstEnabledIndex]);

    const moveSelection = React.useCallback((suggestions: AutocompleteSuggestion[], selected: number, direction: -1 | 1): number => {
        if (suggestions.length === 0) return -1;
        if (suggestions.every(suggestion => suggestion.disabled)) return -1;

        let next = selected;
        for (let attempts = 0; attempts < suggestions.length; attempts++) {
            if (next < 0) {
                next = direction > 0 ? 0 : suggestions.length - 1;
            } else {
                next += direction;
            }

            if (next < 0) {
                if (!wrapAround) return clampToEnabled(suggestions, 0);
                next = suggestions.length - 1;
            } else if (next >= suggestions.length) {
                if (!wrapAround) return clampToEnabled(suggestions, suggestions.length - 1);
                next = 0;
            }

            if (!suggestions[next].disabled) return next;
        }

        return firstEnabledIndex(suggestions);
    }, [clampToEnabled, firstEnabledIndex, wrapAround]);

    const moveUp = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            return { ...prev, selected: moveSelection(prev.suggestions, prev.selected, -1) };
        });
    }, [moveSelection]);

    const moveDown = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            return { ...prev, selected: moveSelection(prev.suggestions, prev.selected, 1) };
        });
    }, [moveSelection]);

    // Sync query to suggestions
    const sync = React.useMemo(() => {
        return new ValueSync<string | null>(async (query) => {
            console.log('🎯 useActiveSuggestions: Processing query:', JSON.stringify(query));
            if (!query) {
                console.log('🎯 useActiveSuggestions: No query, skipping');
                return;
            }
            const suggestions = await handler(query);
            console.log('🎯 useActiveSuggestions: Got suggestions:', JSON.stringify(suggestions, (key, value) => {
                if (key === 'component') return '[Function]';
                return value;
            }, 2));
            setState((prev) => {
                if (clampSelection) {
                    // Simply clamp the selection to valid range
                    let newSelected = prev.selected;

                    if (suggestions.length === 0) {
                        newSelected = -1;
                    } else if (autoSelectFirst && prev.suggestions.length === 0) {
                        // First time showing suggestions, auto-select first
                        newSelected = firstEnabledIndex(suggestions);
                    } else if (prev.selected >= suggestions.length) {
                        // Selection is out of bounds, clamp to last item
                        newSelected = clampToEnabled(suggestions, suggestions.length - 1);
                    } else if (prev.selected < 0 && suggestions.length > 0 && autoSelectFirst) {
                        // No selection but we have suggestions
                        newSelected = firstEnabledIndex(suggestions);
                    } else {
                        newSelected = clampToEnabled(suggestions, newSelected);
                    }

                    return { suggestions, selected: newSelected };
                } else {
                    // Try to preserve selection by key (old behavior)
                    if (prev.selected >= 0 && prev.selected < prev.suggestions.length) {
                        const previousKey = prev.suggestions[prev.selected].key;
                        const newIndex = suggestions.findIndex(s => s.key === previousKey);
                        if (newIndex !== -1) {
                            // Found the same key, keep it selected
                            return { suggestions, selected: newIndex };
                        }
                    }

                    // Key not found or no previous selection, clamp the selection
                    const clampedSelection = Math.min(prev.selected, suggestions.length - 1);
                    return {
                        suggestions,
                        selected: clampedSelection < 0 && suggestions.length > 0 && autoSelectFirst
                            ? firstEnabledIndex(suggestions)
                            : clampToEnabled(suggestions, clampedSelection)
                    };
                }
            });
        });
    }, [clampSelection, autoSelectFirst, handler, firstEnabledIndex, clampToEnabled]);
    React.useEffect(() => {
        sync.setValue(query);
    }, [query]);

    // If no query return empty suggestions
    if (!query) {
        return [[], -1, moveUp, moveDown] as const;
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown] as const;
}
