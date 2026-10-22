package org.joplinu.app

import com.getcapacitor.BridgeActivity
import android.os.Bundle

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(JoplinuDatabasePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
