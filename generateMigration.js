const { execSync } = require('child_process');
const { format } = require('date-fns');
const path = require('path');

try {
    const timestamp = format(new Date(), 'yyyyMMdd_HHmmss');
    const outputFile = path.join('migrations', `${timestamp}_update_schema.sql`);
    const command = `bunx prisma migrate diff --from-schema-datamodel ./src/prisma/schema.previous.prisma --to-schema-datamodel ./src/prisma/schema.prisma --script --output ${outputFile}`;

    execSync(command, { stdio: 'inherit' });
    console.log(`Generated migration file: ${outputFile}`);
    // copy schema.prisma to schema.previous.prisma
    execSync(`cp ./src/prisma/schema.prisma ./src/prisma/schema.previous.prisma`, { stdio: 'inherit' });
    console.log('Updated schema.previous.prisma with the current schema.prisma');
} catch (error) {
    console.error('Error generating migration:', error.message);
    process.exit(1);
}