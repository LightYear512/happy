import * as React from 'react';

export interface AutocompleteSuggestion {
    key: string;
    text: string;
    component: React.ElementType;
    disabled?: boolean;
    submit?: boolean;
    displayText?: string;
}
