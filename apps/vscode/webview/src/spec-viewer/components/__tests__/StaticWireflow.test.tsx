/** @jest-environment jsdom */
import { render } from 'preact';
import { StaticWireflow } from '../StaticWireflow';

describe('StaticWireflow', () => {
    it('renders ordered flow and literal text without creating active markup', () => {
        const host = document.createElement('div');
        const source = '<img src="https://example.invalid/asset">';
        render(<StaticWireflow source={source} preview={{
            fidelity: 'low',
            sections: [
                { id: 'design-surface', children: [{ type: 'label', children: ['Continue'] }, source] },
                { id: 'wireflow', children: [{ type: 'sequence', children: [{ type: 'item', children: ['Confirm'] }] }] },
            ],
            truncated: true,
        }} />, host);
        expect(host.querySelector('section[aria-label="Static prototype preview"]')?.textContent).toContain('controls are not interactive');
        expect(host.querySelector('ol > li')?.textContent).toBe('Confirm');
        expect(host.querySelector('button, a, img, form, script, iframe')).toBeNull();
        expect(host.querySelector('details pre')?.textContent).toBe(source);
        expect(host.textContent).toContain('This preview is shortened');
    });
});
