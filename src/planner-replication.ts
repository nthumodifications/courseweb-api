import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { auth } from "./utils/auth";
import { ensureNotFalsy, lastOfArray, type RxReplicationWriteToMasterRow } from "rxdb/plugins/core";
import { PrismaClient } from "./generated/client";
import { deepCompare } from "./utils/deepCompare";
import { HTTPException } from 'hono/http-exception'

// Initialize Prisma client
const prisma = new PrismaClient();

/**
 * Generic function to handle pull operations for any collection
 */
async function handlePullRequest<T extends { id?: string, uuid?: string, serverTimestamp?: Date, userId?: string, deleted?: boolean }>(
    userId: string | undefined,
    collection: any,
    idField: 'id' | 'uuid',
    queryParams: {
        id?: string,
        uuid?: string,
        serverTimestamp?: string,
        batchSize?: number
    },
    orderBy: Array<{ [key: string]: 'asc' | 'desc' }>
) {
    if (!userId) {
        throw new Error("User ID is required");
    }

    const id = queryParams[idField];
    const { serverTimestamp, batchSize = 10 } = queryParams;
    const lastPulledTimestamp = serverTimestamp ? new Date(serverTimestamp) : null;

    let items;

    if (lastPulledTimestamp) {
        items = await collection.findMany({
            where: {
                userId,
                OR: [
                    {
                        serverTimestamp: {
                            gt: lastPulledTimestamp
                        },
                    },
                    {
                        AND: [
                            { serverTimestamp: lastPulledTimestamp },
                            { [idField]: { gt: id } }
                        ]
                    }
                ]
            },
            orderBy,
            take: batchSize
        });
    } else {
        items = await collection.findMany({
            where: {
                userId
            },
            orderBy,
            take: batchSize
        });
    }

    if (items.length === 0) {
        return {
            checkpoint: lastPulledTimestamp ? { [idField]: id, serverTimestamp } : null,
            documents: []
        };
    }

    const lastDoc = ensureNotFalsy(lastOfArray(items)) as T;
    const documents = items.map((item: T) => {
        const { userId, serverTimestamp, deleted, ...itemData } = item;
        // Map deleted field to _deleted for RxDB
        return {
            ...itemData,
            _deleted: deleted || false
        };
    });

    const newCheckpoint = {
        [idField]: lastDoc[idField as keyof T] as string,
        serverTimestamp: (lastDoc.serverTimestamp as Date).toISOString()
    };

    return {
        documents,
        checkpoint: newCheckpoint
    };
}

/**
 * Generic function to handle push operations for any collection
 */
async function handlePushRequest<T extends Record<string, any>>(
    userId: string | undefined,
    collection: any,
    idField: 'id' | 'uuid',
    rows: RxReplicationWriteToMasterRow<T>[],
    uniqueConstraint: { [key: string]: string } | null = null
) {
    if (!userId) {
        throw new Error("User ID is required");
    }

    const conflicts: (T & { _deleted?: boolean })[] = [];

    // Process each row in a transaction
    await prisma.$transaction(async (tx) => {
        for (const row of rows) {
            const { newDocumentState, assumedMasterState } = row;
            const id = newDocumentState[idField];

            // Build where clause for the unique constraint
            const whereClause = uniqueConstraint
                ? {
                    [uniqueConstraint.name]: {
                        userId,
                        [idField]: id
                    }
                }
                : {
                    [idField]: id,
                    userId
                };

            // Find the current state in the database
            const itemInDb = await collection.findUnique({
                where: whereClause
            });

            // Check for conflicts
            if (itemInDb) {
                const { userId, serverTimestamp, deleted, ...itemData } = itemInDb;

                // Need to map deleted to _deleted for comparison with assumedMasterState
                const itemDataForComparison = {
                    ...itemData,
                    _deleted: deleted || false
                };

                // If we have an assumed state but it doesn't match what's in the DB, it's a conflict
                if (assumedMasterState && !deepCompare(itemDataForComparison, assumedMasterState)) {
                    conflicts.push(itemDataForComparison);
                    continue;
                }
            }

            // Check if the document should be deleted
            if (newDocumentState._deleted) {
                if (itemInDb) {
                    // For a soft delete approach, update the deleted flag instead of deleting the record
                    await collection.update({
                        where: whereClause,
                        data: {
                            deleted: true,
                            serverTimestamp: new Date()
                        }
                    });
                }
                continue;
            }

            // Prepare data for create/update
            const { _deleted, ...itemData } = newDocumentState;
            const data = {
                ...itemData,
                userId,
                deleted: false, // Ensure deleted is set to false for non-delete operations
            };

            // Create or update the item
            await collection.upsert({
                where: whereClause,
                update: data,
                create: data
            });
        }
    });

    return conflicts;
}

const app = new Hono()
    .use(auth(["planner"]))
    .get(
        "/folders/pull",
        zValidator(
            "query",
            z.object({
                id: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const result = await handlePullRequest(
                    user.sub,
                    prisma.folder,
                    'id',
                    params,
                    [{ serverTimestamp: 'asc' }, { id: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in folders/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/folders/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean()
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const conflicts = await handlePushRequest(
                    user.sub,
                    prisma.folder,
                    'id',
                    rows,
                    { name: 'userId_id' }
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in folders/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .get(
        "/items/pull",
        zValidator(
            "query",
            z.object({
                uuid: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const result = await handlePullRequest(
                    user.sub,
                    prisma.item,
                    'uuid',
                    params,
                    [{ serverTimestamp: 'asc' }, { uuid: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in items/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/items/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            uuid: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            uuid: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const conflicts = await handlePushRequest(
                    user.sub,
                    prisma.item,
                    'uuid',
                    rows,
                    null
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in items/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .get(
        "/plannerdata/pull",
        zValidator(
            "query",
            z.object({
                id: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const result = await handlePullRequest(
                    user.sub,
                    prisma.plannerData,
                    'id',
                    params,
                    [{ serverTimestamp: 'asc' }, { id: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in plannerdata/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/plannerdata/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const conflicts = await handlePushRequest(
                    user.sub,
                    prisma.plannerData,
                    'id',
                    rows,
                    { name: 'userId_id' }
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in plannerdata/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .get(
        "/semesters/pull",
        zValidator(
            "query",
            z.object({
                id: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const result = await handlePullRequest(
                    user.sub,
                    prisma.semester,
                    'id',
                    params,
                    [{ serverTimestamp: 'asc' }, { id: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in semesters/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/semesters/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const conflicts = await handlePushRequest(
                    user.sub,
                    prisma.semester,
                    'id',
                    rows,
                    { name: 'userId_id' }
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in semesters/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    );

export default app;