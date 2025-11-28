/**
 * Firestore Setup Script
 * Run once to initialize database with subscription plans and settings
 * 
 * Usage:
 *   node setup-firestore.js
 *   node setup-firestore.js --admin YOUR_EMAIL@gmail.com
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ==============================================
// SUBSCRIPTION PLANS DATA
// ==============================================

const subscriptionPlans = [
  {
    id: 'free',
    name: 'Free Plan',
    description: 'Try before you commit',
    pricing: {
      weekly: 0,
      monthly: 0,
      currency: 'USD'
    },
    limits: {
      warpOptimizer: {
        dailyLimit: 2,
        cooldownHours: 12
      },
      titleGenerator: {
        dailyLimit: 5,
        cooldownHours: 0
      },
      descriptionGenerator: {
        dailyLimit: 3,
        cooldownHours: 0
      },
      tagGenerator: {
        dailyLimit: 5,
        cooldownHours: 0
      }
    },
    features: [
      '2 Warp optimizations per day',
      '12-hour cooldown',
      'Basic support'
    ],
    isActive: true,
    sortOrder: 1,
    badge: null
  },
  {
    id: 'lite',
    name: 'Lite Plan',
    description: 'Perfect for individuals',
    pricing: {
      weekly: 9.99,
      monthly: 29.99,
      currency: 'USD'
    },
    limits: {
      warpOptimizer: {
        dailyLimit: 5,
        cooldownHours: 6
      },
      titleGenerator: {
        dailyLimit: 20,
        cooldownHours: 0
      },
      descriptionGenerator: {
        dailyLimit: 15,
        cooldownHours: 0
      },
      tagGenerator: {
        dailyLimit: 25,
        cooldownHours: 0
      }
    },
    features: [
      '5 Warp optimizations per day',
      '6-hour cooldown',
      'History saved 30 days',
      'Priority support'
    ],
    isActive: true,
    sortOrder: 2,
    badge: 'Popular'
  },
  {
    id: 'pro',
    name: 'Pro Plan',
    description: 'For professionals and teams',
    pricing: {
      weekly: 19.99,
      monthly: 59.99,
      currency: 'USD'
    },
    limits: {
      warpOptimizer: {
        dailyLimit: 20,
        cooldownHours: 2
      },
      titleGenerator: {
        dailyLimit: 100,
        cooldownHours: 0
      },
      descriptionGenerator: {
        dailyLimit: 50,
        cooldownHours: 0
      },
      tagGenerator: {
        dailyLimit: 100,
        cooldownHours: 0
      }
    },
    features: [
      '20 Warp optimizations per day',
      '2-hour cooldown',
      'Unlimited history',
      '24/7 priority support',
      'API access'
    ],
    isActive: true,
    sortOrder: 3,
    badge: null
  },
  {
    id: 'enterprise',
    name: 'Enterprise Plan',
    description: 'Unlimited everything',
    pricing: {
      weekly: 49.99,
      monthly: 149.99,
      currency: 'USD'
    },
    limits: {
      warpOptimizer: {
        dailyLimit: 999999,
        cooldownHours: 0
      },
      titleGenerator: {
        dailyLimit: 999999,
        cooldownHours: 0
      },
      descriptionGenerator: {
        dailyLimit: 999999,
        cooldownHours: 0
      },
      tagGenerator: {
        dailyLimit: 999999,
        cooldownHours: 0
      }
    },
    features: [
      'Unlimited optimizations',
      'No cooldown',
      'Unlimited history',
      'Dedicated support',
      'Custom integrations',
      'White-label option'
    ],
    isActive: true,
    sortOrder: 4,
    badge: 'Best Value'
  }
];

// ==============================================
// ADMIN SETTINGS DATA
// ==============================================

const adminSettings = {
  maintenanceMode: false,
  registrationEnabled: true,
  defaultPlan: 'free',
  trialDuration: 7,
  trialPlan: 'lite',
  notifications: {
    newUserEmail: 'admin@example.com', // Change this to your email
    alertOnHighUsage: true
  },
  features: {
    historyEnabled: true,
    subscriptionsEnabled: true,
    adminDashboardEnabled: true
  }
};

// ==============================================
// SETUP FUNCTIONS
// ==============================================

async function createSubscriptionPlans() {
  console.log('📦 Creating subscription plans...');
  
  for (const plan of subscriptionPlans) {
    try {
      await db.collection('subscriptionPlans').doc(plan.id).set(plan);
      console.log(`   ✅ Created plan: ${plan.name} (${plan.id})`);
    } catch (error) {
      console.error(`   ❌ Error creating ${plan.id}:`, error.message);
    }
  }
  
  console.log('✨ Subscription plans created!\n');
}

async function createAdminSettings() {
  console.log('⚙️  Creating admin settings...');
  
  try {
    await db.collection('adminSettings').doc('config').set(adminSettings);
    console.log('   ✅ Admin settings created!');
  } catch (error) {
    console.error('   ❌ Error creating admin settings:', error.message);
  }
  
  console.log('✨ Admin settings created!\n');
}

async function makeUserAdmin(email) {
  console.log(`👑 Making ${email} an admin...`);
  
  try {
    // Find user by email
    const user = await admin.auth().getUserByEmail(email);
    
    // Create admin document
    await db.collection('adminUsers').doc(user.uid).set({
      uid: user.uid,
      email: user.email,
      role: 'superadmin',
      permissions: [
        'view_users',
        'edit_users',
        'view_analytics',
        'manage_subscriptions',
        'configure_settings'
      ],
      createdBy: 'setup-script',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log('   ✅ Admin user created!');
    console.log(`   📧 Email: ${user.email}`);
    console.log(`   🆔 UID: ${user.uid}`);
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.error(`   ❌ User not found: ${email}`);
      console.error('   💡 Make sure the user has signed in at least once!');
    } else {
      console.error('   ❌ Error creating admin:', error.message);
    }
  }
  
  console.log('');
}

async function verifySetup() {
  console.log('🔍 Verifying setup...\n');
  
  // Check subscription plans
  const plansSnapshot = await db.collection('subscriptionPlans').get();
  console.log(`   📦 Subscription plans: ${plansSnapshot.size}/4`);
  
  // Check admin settings
  const settingsDoc = await db.collection('adminSettings').doc('config').get();
  console.log(`   ⚙️  Admin settings: ${settingsDoc.exists ? '✅' : '❌'}`);
  
  // Check admin users
  const adminsSnapshot = await db.collection('adminUsers').get();
  console.log(`   👑 Admin users: ${adminsSnapshot.size}`);
  
  console.log('\n✨ Setup verification complete!\n');
}

// ==============================================
// MAIN EXECUTION
// ==============================================

async function main() {
  console.log('🚀 Starting Firestore setup...\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  try {
    // Create subscription plans
    await createSubscriptionPlans();
    
    // Create admin settings
    await createAdminSettings();
    
    // Check if --admin flag is provided
    const args = process.argv.slice(2);
    const adminIndex = args.indexOf('--admin');
    
    if (adminIndex !== -1 && args[adminIndex + 1]) {
      const adminEmail = args[adminIndex + 1];
      await makeUserAdmin(adminEmail);
    } else {
      console.log('💡 Tip: Run with --admin YOUR_EMAIL@gmail.com to make yourself admin\n');
    }
    
    // Verify everything was created
    await verifySetup();
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('🎉 Firestore setup complete!\n');
    console.log('Next steps:');
    console.log('1. Enable Google Sign-In in Firebase Console');
    console.log('2. Deploy Cloud Functions');
    console.log('3. Sign in to your app to get your UID');
    console.log('4. Run: node setup-firestore.js --admin your@email.com\n');
    
  } catch (error) {
    console.error('❌ Setup failed:', error);
  } finally {
    process.exit(0);
  }
}

// Run setup
main();
