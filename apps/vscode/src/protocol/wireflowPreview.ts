export type WireflowNode = string | {
    type: 'group' | 'heading' | 'paragraph' | 'list' | 'sequence' | 'item' | 'label'
        | 'table' | 'caption' | 'table-head' | 'table-body' | 'table-foot' | 'row' | 'header' | 'cell'
        | 'pre' | 'code' | 'inline';
    children: WireflowNode[];
};

export interface WireflowPreview {
    fidelity: 'low' | 'mid' | 'high';
    sections: { id: 'design-surface' | 'wireflow'; children: WireflowNode[] }[];
    truncated: boolean;
}
