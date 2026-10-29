package org.joplinu.app

import com.getcapacitor.BridgeActivity
import android.os.Bundle

class MainActivity : BridgeActivity() {
    override fun onPause() { JoplinuCloudPlugin.scheduleOnPause(); super.onPause() }
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(JoplinuDatabasePlugin::class.java)
        registerPlugin(JoplinuCloudPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
