import { describe, expect, it, vi, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import app from './aca-calendar';

describe('ACA Calendar API', () => {
    beforeEach(() => {
        // Reset all mocks
        vi.resetAllMocks();
        
        // Mock environment variable
        process.env.CALENDAR_API_KEY = 'test-api-key';
    });

    it('should return formatted calendar data', async () => {
        // Mock fetch
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                items: [
                    {
                        id: '123',
                        summary: 'Test Event',
                        start: { date: '2023-01-01' },
                        end: { date: '2023-01-02' }
                    }
                ]
            })
        });

        // Create a mock request
        const req = new Request(
            'http://localhost:5001/aca-calendar?start=2023-01-01&end=2023-01-31'
        );
        
        // Create mock context
        const c = {
            req: {
                valid: vi.fn().mockReturnValue({
                    start: new Date('2023-01-01'),
                    end: new Date('2023-01-31')
                })
            },
            json: vi.fn().mockImplementation((data: unknown) => ({ json: data }))
        };

        // Call the handler
        const handler = app.routes[0].handler;
        const mockNext = vi.fn();
        const result = await handler(c as any, mockNext);

        // Verify results
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('https://www.googleapis.com/calendar/v3/calendars/nthu.acad%40gmail.com/events')
        );
        expect(c.json).toHaveBeenCalledWith([
            {
                id: '123',
                summary: 'Test Event',
                date: '2023-01-01'
            }
        ]);
    });

    it('should throw an error when fetch fails', async () => {
        // Mock fetch failure
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: vi.fn().mockResolvedValue('Server error')
        });

        // Create mock context
        const c = {
            req: {
                valid: vi.fn().mockReturnValue({
                    start: new Date('2023-01-01'),
                    end: new Date('2023-01-31')
                })
            }
        };
        // Call the handler and expect exception
        const handler = app.routes[0].handler;
        const mockNext = vi.fn();
        await expect(handler(c as any, mockNext)).rejects.toThrow('Failed to fetch data 500Server error');
    });
});