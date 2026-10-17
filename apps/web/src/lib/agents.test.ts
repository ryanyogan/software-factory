import { describe, expect, it } from 'vite-plus/test';
import { agentsFor } from './agents';

describe('agentsFor', () => {
  it('offers fake only on loopback', () => {
    expect(agentsFor('localhost')).toContain('fake');
    expect(agentsFor('127.0.0.1')).toContain('fake');
    expect(agentsFor('sf.example.com')).not.toContain('fake');
    expect(agentsFor(undefined)).not.toContain('fake');
  });
});
