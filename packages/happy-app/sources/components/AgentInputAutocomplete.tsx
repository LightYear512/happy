import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FloatingOverlay } from './FloatingOverlay';

interface AgentInputAutocompleteProps {
    suggestions: Array<{
        element: React.ReactElement;
        disabled?: boolean;
    }>;
    selectedIndex?: number;
    onSelect: (index: number) => void;
    itemHeight: number;
}

export const AgentInputAutocomplete = React.memo((props: AgentInputAutocompleteProps) => {
    const { suggestions, selectedIndex = -1, onSelect, itemHeight } = props;
    const { theme } = useUnistyles();

    if (suggestions.length === 0) {
        return null;
    }

    return (
        <FloatingOverlay maxHeight={240} keyboardShouldPersistTaps="handled">
            {suggestions.map((suggestion, index) => (
                <Pressable
                    key={index}
                    disabled={suggestion.disabled}
                    onPress={() => {
                        if (!suggestion.disabled) onSelect(index);
                    }}
                    style={({ pressed }) => ({
                        height: itemHeight,
                        backgroundColor: pressed
                            ? theme.colors.surfacePressed
                            : selectedIndex === index && !suggestion.disabled
                                ? theme.colors.surfaceSelected
                                : 'transparent',
                        opacity: suggestion.disabled ? 0.65 : 1,
                    })}
                >
                    {suggestion.element}
                </Pressable>
            ))}
        </FloatingOverlay>
    );
});
