/**
 * @license Mastra Enterprise License - see ee/LICENSE
 */
import { FGADeniedError, MastraFGAPermissions } from '@mastra/core/auth/ee';
import type { FGACheckParams, IFGAProvider, MastraFGAPermissionInput } from '@mastra/core/auth/ee';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { MCPServer } from '../server';
import { connectClient, serveHTTP, textOf } from './harness.mock';

type User = { id: string };

// A real, mutable in-memory policy store: no framework or transport mocks.
class RevocablePolicy implements IFGAProvider<User> {
  allowed = true;
  unavailable = false;

  async check(_user: User, _params: FGACheckParams) {
    if (this.unavailable) throw new Error('Policy store unavailable');
    return this.allowed;
  }

  async require(user: User, params: FGACheckParams) {
    if (!(await this.check(user, params))) throw new FGADeniedError(user, params.resource, params.permission);
  }

  async filterAccessible<T extends { id: string }>(
    user: User,
    resources: T[],
    resourceType: string,
    permission: MastraFGAPermissionInput,
  ): Promise<T[]> {
    const allowed = await Promise.all(
      resources.map(resource => this.check(user, { resource: { type: resourceType, id: resource.id }, permission })),
    );
    return resources.filter((_resource, index) => allowed[index]);
  }
}

describe.each(['direct', 'http'] as const)('MCP permission changes through %s execution', path => {
  // Confirmed on 1be23784ae3c21c99a134371929bff47a6fc6ba0, three runs per path.
  // Follow-up to #17508: the core wrapper rechecks standalone tool:record/tools:execute.
  it('executes a listed tool using the configured resource and permission mapping', async () => {
    const effects: string[] = [];
    class MappedPolicy extends RevocablePolicy {
      override async check(user: User, params: FGACheckParams) {
        return (
          user.id === 'operator' &&
          params.resource.type === 'team' &&
          params.resource.id === 'team-1' &&
          params.permission === 'read'
        );
      }
    }
    const fga = new MappedPolicy();
    const server = new MCPServer({
      name: 'mapped-regression',
      version: '1.0.0',
      mapAuthInfoToUser: () => ({ id: 'operator' }),
      fga: {
        resourceMapping: { tool: { fgaResourceType: 'team', deriveId: () => 'team-1' } },
        permissionMapping: { [MastraFGAPermissions.TOOLS_EXECUTE]: 'read' },
      },
      tools: {
        record: createTool({
          id: 'record',
          description: 'Record a mapped operation',
          inputSchema: z.object({}),
          outputSchema: z.object({ recorded: z.boolean() }),
          execute: async () => {
            effects.push('recorded');
            return { recorded: true };
          },
        }),
      },
    });
    new Mastra({ logger: false, server: { fga }, mcpServers: { regression: server } });
    const requestContext = new RequestContext();
    requestContext.set('user', { id: 'operator' });
    const served =
      path === 'http'
        ? await serveHTTP(server, { auth: { token: 'local-test', clientId: 'operator-client', scopes: [] } })
        : undefined;
    const client = served ? await connectClient(served.url) : undefined;
    try {
      const listed = client ? await client.listTools() : await server.getToolListInfo(requestContext);
      expect(listed.tools.map(tool => tool.name)).toEqual(['record']);
      if (client) {
        const result = await client.callTool({ name: 'record', arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ recorded: true });
      } else {
        const result = await server.executeTool('record', {}, { requestContext });
        expect(result).toMatchObject({ status: 'completed', output: { recorded: true } });
      }
      expect(effects).toEqual(['recorded']);
    } finally {
      await client?.close();
      if (served) await served.close();
      else await server.close();
    }
  }, 20_000);

  it('blocks a previously listed tool after revocation and permits it after access is restored', async () => {
    const effects: string[] = [];
    const fga = new RevocablePolicy();
    const server = new MCPServer({
      name: 'revocation-regression',
      version: '1.0.0',
      mapAuthInfoToUser: () => ({ id: 'operator' }),
      tools: {
        record: createTool({
          id: 'record',
          description: 'Record an authorized operation',
          inputSchema: z.object({ value: z.string() }),
          outputSchema: z.object({ recorded: z.string() }),
          execute: async ({ value }) => {
            effects.push(value);
            return { recorded: value };
          },
        }),
      },
    });
    // Register using the public constructor, so real Mastra wiring participates.
    new Mastra({ logger: false, server: { fga }, mcpServers: { regression: server } });
    const requestContext = new RequestContext();
    requestContext.set('user', { id: 'operator' });
    const served =
      path === 'http'
        ? await serveHTTP(server, { auth: { token: 'local-test', clientId: 'operator-client', scopes: [] } })
        : undefined;
    const client = served ? await connectClient(served.url) : undefined;
    try {
      const list = () => (client ? client.listTools() : server.getToolListInfo(requestContext));
      const call = (value: string) =>
        client
          ? client.callTool({ name: 'record', arguments: { value } })
          : server.executeTool('record', { value }, { requestContext });
      const expectBlocked = async (value: string, message: string) => {
        if (client) {
          const result = await client.callTool({ name: 'record', arguments: { value } });
          expect(result.isError).toBe(true);
          expect(textOf(result)).toContain(message);
        } else {
          await expect(call(value)).rejects.toThrow(message);
        }
      };

      expect((await list()).tools.map(tool => tool.name)).toEqual(['record']);
      await call('before');
      expect(effects).toEqual(['before']);

      fga.allowed = false;
      // Call before relisting: a cached discovery result must not grant access.
      await expectBlocked('revoked', 'denied');
      expect(effects).toEqual(['before']);
      expect((await list()).tools).toEqual([]);

      fga.allowed = true;
      await call('restored');
      expect(effects).toEqual(['before', 'restored']);

      fga.unavailable = true;
      await expectBlocked('outage', 'Policy store unavailable');
      expect(effects).toEqual(['before', 'restored']);
    } finally {
      await client?.close();
      if (served) await served.close();
      else await server.close();
    }
  }, 20_000);
});
